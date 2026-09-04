#include <WiFi.h>
#include <WebServer.h>
#include <Firebase_ESP_Client.h> 
#include <ESP32Servo.h>
#include "DHT.h"

// Firebase Helper Addons
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// --- Hardware & Local Network Credentials ---
const char* ssid = "We_are_6";
const char* password = "33780450";

// --- Firebase Credentials ---
#define API_KEY "AIzaSyDooeQFt1kU5j34F8CI_UZ3QuEmeAu8NG8"
#define DATABASE_URL "smartshed-cd1d0-default-rtdb.asia-southeast1.firebasedatabase.app" 

// --- Sensor & Actuator Pin Allocations ---
#define DHTPIN 4
#define GAS_PIN 34
#define LDR_PIN 35
#define RAIN_PIN 32
#define SERVO_PIN 12      // Water Spray Servo Motor Pin (GPIO 12)

// --- POWER SOURCE INDICATOR LEDS ---
#define AC_LED_PIN 19     // 🔌 AC Power Indicator LED Pin (GPIO 19)
#define SOLAR_LED_PIN 21  // ☀️ Solar Power Indicator LED Pin (GPIO 21)

// --- Load Relay Controls ---
#define FAN1_PIN 25       
#define FAN2_PIN 26       
#define HEAT_LIGHT_PIN 27 
#define PUMP_PIN 23       
#define NIGHT_LIGHT_PIN 14 

// --- Deek-Robot L293D DC Gear Motor Driver Map ---
#define MOTOR_IN1 5       
#define MOTOR_IN2 18      

// --- Module Instance Definitions ---
DHT dht(DHTPIN, DHT11);
WebServer server(80);
Servo sprayServo;

// Firebase Data Objects
FirebaseData fbdo;
FirebaseData fbdo_sync; 
FirebaseAuth auth;
FirebaseConfig config;
unsigned long sendDataPrevMillis = 0;

// --- INDEPENDENT AUTOMATION MATRIX ---
bool autoFan1 = true;
bool autoFan2 = true;
bool autoHeat = true;
bool autoCurtain = true;
bool autoNightLight = true; 
bool autoSpray = true;    

bool isSpraying = false;
const int gasThreshold = 2500; 

// Sustained Reading Filter
int fan1FilterCounter = 0; 

// Automatic Spray Cooldown & Threshold Constants
const float LOW_HUMIDITY_THRESHOLD = 30.0;       
const unsigned long AUTO_SPRAY_COOLDOWN = 30000; 
unsigned long lastAutoSprayMillis = 0;

// --- POWER SOURCE TIME TRACKING VARIABLES ---
bool isSolarActive = false;
unsigned long solarTotalMillis = 0;
unsigned long acTotalMillis = 0; 
unsigned long lastPowerCheckMillis = 0;
const int LDR_LIGHT_THRESHOLD = 1800;

// --- Sensor Cache ---
float cachedTemp = 0.0;
float cachedHum = 0.0;
int cachedGas = 0;
int cachedLight = 0;
int cachedRain = 0;
unsigned long lastSensorReadMillis = 0;
const unsigned long SENSOR_READ_INTERVAL = 1000;

// --- DC Motor Runtime Watchdog Matrix ---
enum CurtainState { CLOSED = 0, OPEN = 1, CLOSING = 2, OPENING = 3 };
CurtainState currentStatus = CLOSED;
CurtainState targetStatus = CLOSED;
unsigned long motorStartTime = 0;
const unsigned long DRIVE_DURATION = 12000; 

void stopCurtains() {
  digitalWrite(MOTOR_IN1, LOW);
  digitalWrite(MOTOR_IN2, LOW);
}

void triggerCurtainMove(CurtainState target) {
  if (currentStatus == target || currentStatus == CLOSING || currentStatus == OPENING) return;
  targetStatus = target;
  motorStartTime = millis();
  if (target == OPEN) {
    currentStatus = OPENING;
    digitalWrite(MOTOR_IN1, HIGH); digitalWrite(MOTOR_IN2, LOW);
  } else {
    currentStatus = CLOSING;
    digitalWrite(MOTOR_IN1, LOW); digitalWrite(MOTOR_IN2, HIGH);
  }
}

// ─── SERVO WATER SPRAY EXECUTION ENGINE (3 RAPID CLICKS) ─────────
void triggerWaterSpray() {
  if (isSpraying) return;
  isSpraying = true;
  Serial.println(">> [SERVO] Rapidly Clicking Water Spray 3 Times...");
  
  for (int i = 0; i < 3; i++) {
    sprayServo.write(80);  // Press position
    delay(250);            
    sprayServo.write(0);   // Release position
    delay(200);            
  }
  
  sprayServo.write(0); // Ensure back at zero idle
  isSpraying = false;

  if (Firebase.ready()) {
    Firebase.RTDB.setBool(&fbdo, "/FarmData/actuators/spray", false);
  }
}

// ─── POWER SOURCE & LDR MANAGEMENT ──────────────────────────────
void updatePowerSourceAndTimer(int lightVal) {
  unsigned long now = millis();
  unsigned long elapsed = now - lastPowerCheckMillis;
  lastPowerCheckMillis = now;

  if (lightVal > LDR_LIGHT_THRESHOLD) {
    digitalWrite(SOLAR_LED_PIN, HIGH);
    digitalWrite(AC_LED_PIN, LOW);
    if (isSolarActive) solarTotalMillis += elapsed;
    isSolarActive = true;
  } else {
    digitalWrite(SOLAR_LED_PIN, LOW);
    digitalWrite(AC_LED_PIN, HIGH);
    if (!isSolarActive) acTotalMillis += elapsed;
    isSolarActive = false;
  }
}

// ─── INDEPENDENT AUTOMATION RULES ─────────────────────────
void runAutomationRules(float t, float h, int gas, int light, int rain) {
  updatePowerSourceAndTimer(light);

  if (gas > gasThreshold) {
    if (autoFan2) digitalWrite(FAN2_PIN, LOW); 
  } else {
    if (autoFan2) {
      if (!isnan(t) && t > 35) digitalWrite(FAN2_PIN, LOW);
      else digitalWrite(FAN2_PIN, HIGH);
    }
  }

  if (autoFan1) {
    if (!isnan(t) && !isnan(h)) {
      if (t >= 32 || h >= 60) {
        fan1FilterCounter++;
        if (fan1FilterCounter >= 20) digitalWrite(FAN1_PIN, LOW);
      } else {
        fan1FilterCounter = 0;
        digitalWrite(FAN1_PIN, HIGH);
      }
    }
  }

  if (autoHeat) {
    if (!isnan(t)) {
      if (t < 25) digitalWrite(HEAT_LIGHT_PIN, LOW);
      else if (t >= 28) digitalWrite(HEAT_LIGHT_PIN, HIGH);
    }
  }

  if (autoNightLight) {
    if (light <= LDR_LIGHT_THRESHOLD) digitalWrite(NIGHT_LIGHT_PIN, LOW); 
    else digitalWrite(NIGHT_LIGHT_PIN, HIGH); 
  }

  if (autoSpray) {
    if (!isnan(h) && h < LOW_HUMIDITY_THRESHOLD) {
      if (millis() - lastAutoSprayMillis >= AUTO_SPRAY_COOLDOWN || lastAutoSprayMillis == 0) {
        lastAutoSprayMillis = millis();
        Serial.println(">> [AUTO] Low Humidity. Triggering 3-Click Water Spray...");
        triggerWaterSpray();
      }
    }
  }

  if (autoCurtain && currentStatus != OPENING && currentStatus != CLOSING) {
    if (rain > 20) triggerCurtainMove(CLOSED);
    else if (!isnan(t) && t > 30) triggerCurtainMove(OPEN);
    else {
      if (light > LDR_LIGHT_THRESHOLD) triggerCurtainMove(OPEN);
      else triggerCurtainMove(CLOSED);
    }
  }
}

void updateSensorReadings() {
  if (millis() - lastSensorReadMillis >= SENSOR_READ_INTERVAL || lastSensorReadMillis == 0) {
    lastSensorReadMillis = millis();
    float newH = dht.readHumidity();
    float newT = dht.readTemperature();
    if (!isnan(newH) && !isnan(newT)) {
      cachedHum = newH;
      cachedTemp = newT;
    }
    cachedGas = analogRead(GAS_PIN);
    cachedLight = 4095 - analogRead(LDR_PIN); 
    cachedRain = map(analogRead(RAIN_PIN), 4095, 0, 0, 100);
    if (cachedRain < 0) cachedRain = 0;
    
    runAutomationRules(cachedTemp, cachedHum, cachedGas, cachedLight, cachedRain);
  }
}

void handleData() {
  String json = "{";
  json += "\"temp\":" + String(isnan(cachedTemp) ? 0 : cachedTemp) + ",";
  json += "\"hum\":" + String(isnan(cachedHum) ? 0 : cachedHum) + ",";
  json += "\"gas\":" + String(cachedGas) + ",";
  json += "\"light\":" + String(cachedLight) + ",";
  json += "\"rain\":" + String(cachedRain) + ",";
  json += "\"powerSource\":\"" + String(isSolarActive ? "Solar Power ☀️" : "AC Power 🔌") + "\",";
  json += "\"solarRuntimeSec\":" + String(solarTotalMillis / 1000) + ",";
  json += "\"acRuntimeSec\":" + String(acTotalMillis / 1000);
  json += "}";
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", json);
}

// --- Local Web Server Sync Endpoints ---
void toggleFan1() { autoFan1 = false; digitalWrite(FAN1_PIN, !digitalRead(FAN1_PIN)); server.send(200); }
void toggleFan2() { autoFan2 = false; digitalWrite(FAN2_PIN, !digitalRead(FAN2_PIN)); server.send(200); }
void toggleHeat() { autoHeat = false; digitalWrite(HEAT_LIGHT_PIN, !digitalRead(HEAT_LIGHT_PIN)); server.send(200); }
void toggleNightLight() { autoNightLight = false; digitalWrite(NIGHT_LIGHT_PIN, !digitalRead(NIGHT_LIGHT_PIN)); server.send(200); }
void togglePump() { digitalWrite(PUMP_PIN, !digitalRead(PUMP_PIN)); server.send(200); } 
void setCurtainOpen() { autoCurtain = false; triggerCurtainMove(OPEN); server.send(200); }
void setCurtainClose() { autoCurtain = false; triggerCurtainMove(CLOSED); server.send(200); }
void handleSprayEndpoint() { triggerWaterSpray(); server.send(200, "text/plain", "Sprayed"); }
void toggleAutoSpray() { autoSpray = !autoSpray; server.send(200); }

void syncManualControls() {
  if (Firebase.RTDB.getJSON(&fbdo_sync, "/FarmData/automation")) {
    FirebaseJson *json = fbdo_sync.jsonObjectPtr();
    FirebaseJsonData res;
    if (json->get(res, "autoFan1")) autoFan1 = res.boolValue;
    if (json->get(res, "autoFan2")) autoFan2 = res.boolValue;
    if (json->get(res, "autoHeat")) autoHeat = res.boolValue;
    if (json->get(res, "autoNightLight")) autoNightLight = res.boolValue;
    if (json->get(res, "autoCurtain")) autoCurtain = res.boolValue;
    if (json->get(res, "autoSpray")) autoSpray = res.boolValue; 
  }

  if (Firebase.RTDB.getJSON(&fbdo_sync, "/FarmData/actuators")) {
    FirebaseJson *json = fbdo_sync.jsonObjectPtr();
    FirebaseJsonData res;

    if (!autoFan1 && json->get(res, "fan1")) digitalWrite(FAN1_PIN, res.boolValue ? LOW : HIGH);
    if (!autoFan2 && json->get(res, "fan2")) digitalWrite(FAN2_PIN, res.boolValue ? LOW : HIGH);
    if (!autoHeat && json->get(res, "heatlight")) digitalWrite(HEAT_LIGHT_PIN, res.boolValue ? LOW : HIGH);
    if (!autoNightLight && json->get(res, "nightlight")) digitalWrite(NIGHT_LIGHT_PIN, res.boolValue ? LOW : HIGH);
    if (json->get(res, "pump")) digitalWrite(PUMP_PIN, res.boolValue ? LOW : HIGH);

    if (json->get(res, "spray") && res.boolValue == true) {
      triggerWaterSpray();
    }

    if (!autoCurtain && json->get(res, "curtainStatus")) {
      int target = res.intValue;
      if (target == 1) triggerCurtainMove(OPEN);
      else if (target == 0) triggerCurtainMove(CLOSED);
    }
  }
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  
  pinMode(FAN1_PIN, OUTPUT);       digitalWrite(FAN1_PIN, HIGH);
  pinMode(FAN2_PIN, OUTPUT);       digitalWrite(FAN2_PIN, HIGH);
  pinMode(HEAT_LIGHT_PIN, OUTPUT); digitalWrite(HEAT_LIGHT_PIN, HIGH);
  pinMode(PUMP_PIN, OUTPUT);       digitalWrite(PUMP_PIN, HIGH); 
  pinMode(NIGHT_LIGHT_PIN, OUTPUT); digitalWrite(NIGHT_LIGHT_PIN, HIGH); 
  pinMode(MOTOR_IN1, OUTPUT);      pinMode(MOTOR_IN2, OUTPUT);
  stopCurtains();

  pinMode(AC_LED_PIN, OUTPUT);    digitalWrite(AC_LED_PIN, LOW);
  pinMode(SOLAR_LED_PIN, OUTPUT); digitalWrite(SOLAR_LED_PIN, LOW);
  lastPowerCheckMillis = millis();

  ESP32PWM::allocateTimer(0);
  sprayServo.setPeriodHertz(50);
  sprayServo.attach(SERVO_PIN, 500, 2400);
  sprayServo.write(0);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\n[LIVE] ESP32 Connected: " + WiFi.localIP().toString());

  configTime(0, 0, "pool.ntp.org");

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  config.signer.test_mode = true; 
  config.cert.data = NULL; 

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  server.on("/data", handleData);
  server.on("/f1", toggleFan1); server.on("/f2", toggleFan2);
  server.on("/heat", toggleHeat); 
  server.on("/nl", toggleNightLight); server.on("/pump", togglePump);
  server.on("/c_open", setCurtainOpen); server.on("/c_close", setCurtainClose);
  server.on("/spray", handleSprayEndpoint);
  server.on("/auto_spray", toggleAutoSpray);
  
  server.begin();
}

void loop() {
  server.handleClient();
  updateSensorReadings();
  
  if ((currentStatus == OPENING || currentStatus == CLOSING) && (millis() - motorStartTime >= DRIVE_DURATION)) {
    stopCurtains(); currentStatus = targetStatus;
  }

  // Synchronize with Firebase
  if (Firebase.ready() && (millis() - sendDataPrevMillis > 1000 || sendDataPrevMillis == 0)) {
    sendDataPrevMillis = millis();

    syncManualControls();

    FirebaseJson updateData;
    updateData.set("lastSeen", (double)millis()); // Heartbeat tracker
    updateData.set("temp", isnan(cachedTemp) ? 0 : cachedTemp);
    updateData.set("hum", isnan(cachedHum) ? 0 : cachedHum);
    updateData.set("gas", cachedGas);
    updateData.set("light", cachedLight);
    updateData.set("rain", cachedRain);
    
    updateData.set("power/source", isSolarActive ? "Solar Power ☀️" : "AC Power 🔌");
    updateData.set("power/acPower", digitalRead(AC_LED_PIN) == HIGH);
    updateData.set("power/solarPower", digitalRead(SOLAR_LED_PIN) == HIGH);
    updateData.set("power/solarRuntimeSec", solarTotalMillis / 1000);
    updateData.set("power/acRuntimeSec", acTotalMillis / 1000);

    updateData.set("actuators/fan1", !digitalRead(FAN1_PIN));
    updateData.set("actuators/fan2", !digitalRead(FAN2_PIN));
    updateData.set("actuators/heatlight", !digitalRead(HEAT_LIGHT_PIN));
    updateData.set("actuators/pump", !digitalRead(PUMP_PIN));
    updateData.set("actuators/nightlight", !digitalRead(NIGHT_LIGHT_PIN));
    updateData.set("actuators/spray", isSpraying);
    updateData.set("actuators/curtainStatus", (int)currentStatus);

    updateData.set("automation/autoFan1", autoFan1);
    updateData.set("automation/autoFan2", autoFan2);
    updateData.set("automation/autoHeat", autoHeat);
    updateData.set("automation/autoCurtain", autoCurtain);
    updateData.set("automation/autoNightLight", autoNightLight);
    updateData.set("automation/autoSpray", autoSpray);

    if (Firebase.RTDB.updateNode(&fbdo, "/FarmData", &updateData)) {
        Serial.println(">> Database Synced with Firebase.");
    } else {
        Serial.println(">> Firebase Error: " + fbdo.errorReason());
    }
  }
}