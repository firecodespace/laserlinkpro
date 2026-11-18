/*
  LaserLink - NodeMCU (ESP8266) Wi-Fi gateway
  IoT-Based Product Design, AIDC. Phase-0 prototype.

  Brings up its own access point and serves a small page. Anything typed
  there is pushed down a one-wire serial link to the Arduino Uno, which
  flashes it out through the laser. This is the "IoT" half of the project:
  a phone on the AP can inject traffic into the optical link.

  Wiring
    NodeMCU D5 (GPIO14) -> Uno D10        the only signal wire
    NodeMCU G           -> Uno GND rail   shared ground is REQUIRED
    Power the NodeMCU from its own micro-USB cable.

    Do NOT connect 3V3 or Vin to the Uno, and do NOT connect Uno D11 to the
    NodeMCU: the Uno drives 5 V and this board is 3.3 V only.

  Wi-Fi     SSID "LaserLink-Node", password "laserlink"
  Page      http://192.168.4.1
  Serial    115200 baud for debugging
*/

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <SoftwareSerial.h>

const char *AP_SSID = "LaserLink-Node";
const char *AP_PASS = "laserlink";

/*
  Optional: join an existing Wi-Fi network as well as serving the page.

  Leave STA_SSID empty for the self-contained demo - the board makes its own
  access point and lives at 192.168.4.1. The catch is that a laptop joined to
  that AP has no internet, so it cannot load the hosted web app.

  Fill these in and the board ALSO joins your normal network and prints the
  address it was given. The laptop then stays online, runs the chat page from
  the local dev server, and posts messages to that address.
*/
const char *STA_SSID = "";
const char *STA_PASS = "";

const uint32_t STA_TIMEOUT_MS = 12000;

const uint8_t PIN_TO_UNO = D5;   // GPIO14 -> Uno D10

ESP8266WebServer server(80);
SoftwareSerial unoLink;

uint32_t sentCount = 0;
String lastSent = "(nothing yet)";

// ------------------------------------------------------------------ page
const char PAGE_HEAD[] PROGMEM =
  "<!doctype html><html><head><meta charset=utf-8>"
  "<meta name=viewport content='width=device-width,initial-scale=1'>"
  "<title>LaserLink Node</title><style>"
  "*{box-sizing:border-box}"
  "body{margin:0;background:#0b0e13;color:#e6ebf3;font-family:system-ui,sans-serif;padding:20px}"
  ".wrap{max-width:520px;margin:0 auto}"
  "h1{font-size:20px;margin:0 0 4px;display:flex;align-items:center;gap:9px}"
  ".dot{width:11px;height:11px;border-radius:50%;background:#ff3b30;box-shadow:0 0 10px 2px rgba(255,59,48,.6)}"
  "p.s{color:#8b99ae;font-size:13px;margin:0 0 18px;line-height:1.5}"
  ".card{background:#141922;border:1px solid #273243;border-radius:10px;padding:16px;margin-bottom:14px}"
  "label{display:block;font-size:11px;color:#8b99ae;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}"
  "input[type=text]{width:100%;font:inherit;background:#0e131b;color:#e6ebf3;border:1px solid #273243;border-radius:8px;padding:10px}"
  "button{font:inherit;font-size:14px;background:#1b222e;color:#e6ebf3;border:1px solid #273243;border-radius:8px;padding:10px 14px;cursor:pointer;margin:6px 6px 0 0}"
  "button.p{background:#ff3b30;border-color:#ff3b30;color:#fff;font-weight:600}"
  ".k{font-size:12px;color:#8b99ae;font-family:ui-monospace,Consolas,monospace;margin-top:12px;line-height:1.7}"
  ".warn{border:1px solid #7a1f1a;background:rgba(255,59,48,.07);border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.55;color:#e6ebf3}"
  "</style></head><body><div class=wrap>"
  "<h1><span class=dot></span>LaserLink Node</h1>"
  "<p class=s>Messages sent from here travel over one wire to the Uno, then out through the laser to the camera receiver. About 18 seconds per short message.</p>";

const char PAGE_TAIL[] PROGMEM =
  "<div class=warn><b>Laser safety.</b> Class 3R. Keep the beam at table height on the paper, never toward eyes or shiny surfaces.</div>"
  "</div></body></html>";

String buildPage() {
  String h = FPSTR(PAGE_HEAD);

  h += F("<div class=card><form action='/send' method='get'>"
         "<label>Message to flash</label>"
         "<input type=text name=msg maxlength=60 value='' placeholder='HELLO FROM WIFI' autocomplete=off>"
         "<button class=p type=submit>Send over laser</button></form></div>");

  h += F("<div class=card><label>Quick actions</label>"
         "<a href='/send?msg=TEMP+27.5C'><button>Sensor reading</button></a>"
         "<a href='/send?msg=HELLO+FROM+WIFI'><button>Hello</button></a>"
         "<a href='/cmd?c=%23TEST'><button>#TEST</button></a>"
         "<a href='/cmd?c=%23ON'><button>Laser on</button></a>"
         "<a href='/cmd?c=%23OFF'><button>Laser off</button></a>");

  h += F("<div class=k>sent: ");
  h += String(sentCount);
  h += F("<br>last: ");
  h += lastSent;
  h += F("<br>uptime: ");
  h += String(millis() / 1000);
  h += F(" s</div></div>");

  h += FPSTR(PAGE_TAIL);
  return h;
}

// --------------------------------------------------------------- routing
void pushToUno(const String &line) {
  unoLink.print(line);
  unoLink.print('\n');
  sentCount++;
  lastSent = line;
  Serial.print(F("-> Uno: "));
  Serial.println(line);
}

void handleRoot() {
  server.send(200, "text/html", buildPage());
}

void redirectHome() {
  server.sendHeader("Location", "/", true);
  server.send(302, "text/plain", "");
}

void handleSend() {
  String msg = server.arg("msg");
  msg.trim();
  if (msg.length() == 0) {
    redirectHome();
    return;
  }
  if (msg.length() > 60) msg = msg.substring(0, 60);
  msg.toUpperCase();
  pushToUno(msg);
  redirectHome();
}

void handleCmd() {
  String c = server.arg("c");
  c.trim();
  if (c.length() > 0) pushToUno(c);
  redirectHome();
}

/*
  JSON API used by the Chat page's Wi-Fi transport.

  The browser calls this from a different origin, so the reply needs an
  Access-Control-Allow-Origin header or the fetch is rejected. Note that an
  https page still cannot call this plain http board - the browser blocks it
  as mixed content - so the chat sender must be on http://localhost.
*/
void sendCors() {
  server.sendHeader(F("Access-Control-Allow-Origin"), F("*"));
  server.sendHeader(F("Access-Control-Allow-Methods"), F("GET, OPTIONS"));
}

void handleApiSend() {
  String msg = server.arg("msg");
  msg.trim();
  sendCors();
  if (msg.length() == 0) {
    server.send(400, F("application/json"), F("{\"ok\":false,\"error\":\"empty message\"}"));
    return;
  }
  if (msg.length() > 60) msg = msg.substring(0, 60);
  if (!msg.startsWith("#")) msg.toUpperCase();
  pushToUno(msg);
  String j = F("{\"ok\":true,\"sent\":\"");
  j += msg;
  j += F("\",\"count\":");
  j += String(sentCount);
  j += F("}");
  server.send(200, F("application/json"), j);
}

void handleApiOptions() {
  sendCors();
  server.send(204, F("text/plain"), "");
}

void handleStatus() {
  String j = F("{\"sent\":");
  j += String(sentCount);
  j += F(",\"last\":\"");
  j += lastSent;
  j += F("\",\"uptime\":");
  j += String(millis() / 1000);
  j += F("}");
  server.send(200, "application/json", j);
}

// ----------------------------------------------------------------- setup
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println(F("LaserLink NodeMCU starting"));

  // Transmit only: no RX pin, so nothing 5 V can reach this board.
  unoLink.begin(9600, SWSERIAL_8N1, -1, PIN_TO_UNO, false);

  WiFi.mode(WIFI_AP);
  bool ok = WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print(F("AP \""));
  Serial.print(AP_SSID);
  Serial.println(ok ? F("\" up") : F("\" FAILED"));
  Serial.print(F("Open http://"));
  Serial.println(WiFi.softAPIP());

  server.on("/", handleRoot);
  server.on("/send", handleSend);
  server.on("/cmd", handleCmd);
  server.on("/status", handleStatus);
  server.onNotFound(redirectHome);
  server.begin();
  Serial.println(F("Web server ready on port 80"));
}

void loop() {
  server.handleClient();
}
