import http.server
import socketserver
import json
import smtplib
import os
import threading
import datetime
import uuid
import time
import random
import traceback
import urllib.request
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from urllib.parse import urlparse, parse_qs
import sys
from dotenv import load_dotenv

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Load environment variables from .env file (never commit .env to git)
load_dotenv()

# ==========================================
# 📧 EMAIL CONFIGURATION (loaded from .env)
# ==========================================
SENDER_EMAIL    = os.getenv('SENDER_EMAIL', '')
SENDER_PASSWORD = os.getenv('SENDER_PASSWORD', '')

RESEND_API_KEY   = os.getenv('RESEND_API_KEY', '').strip()
BREVO_API_KEY    = os.getenv('BREVO_API_KEY', '').strip()
SENDGRID_API_KEY = os.getenv('SENDGRID_API_KEY', '').strip()

if not SENDER_EMAIL or not SENDER_PASSWORD:
    print("WARNING: SENDER_EMAIL or SENDER_PASSWORD not set in .env — SMTP email sending will fail.")

# ==========================================
# ⚡ SUPABASE & ENVIRONMENT CONFIGURATION
# ==========================================
SUPABASE_URL = os.getenv('SUPABASE_URL', '').strip()
SUPABASE_ANON_KEY = os.getenv('SUPABASE_ANON_KEY', '').strip()
ALLOWED_ORIGIN = os.getenv('ALLOWED_ORIGIN', '*')
ADMIN_PASSCODE = os.getenv('ADMIN_PASSCODE', 'admin123')

print("==========================================")
print("⚡ REFILLX RUNTIME ENVIRONMENT CHECK:")
print(f"   SUPABASE_URL: {'SET (' + str(len(SUPABASE_URL)) + ' chars, ' + SUPABASE_URL[:15] + '...)' if SUPABASE_URL else '❌ NOT SET (empty)'}")
print(f"   SUPABASE_ANON_KEY: {'SET (' + str(len(SUPABASE_ANON_KEY)) + ' chars)' if SUPABASE_ANON_KEY else '❌ NOT SET (empty)'}")
print(f"   SENDER_EMAIL: {'SET (' + SENDER_EMAIL + ')' if SENDER_EMAIL else '⚠️ NOT SET'}")
print(f"   ALLOWED_ORIGIN: {ALLOWED_ORIGIN}")
print("==========================================")


def sync_to_supabase(table, data, method='POST', match=None):
    """
    method='POST'  → upsert (insert or merge) — for sessions, orders
    method='PATCH' → update existing row matching `match` dict — for tanks, users
    """
    if not SUPABASE_URL or not SUPABASE_URL.startswith(('http://', 'https://')) or not SUPABASE_ANON_KEY:
        print(f"⚠️ Supabase sync skipped for '{table}': SUPABASE_URL ('{SUPABASE_URL}') is empty or invalid, or SUPABASE_ANON_KEY missing.")
        return

    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{table}"

    # For PATCH, append filter query params
    if method == 'PATCH' and match:
        filters = '&'.join([f"{k}=eq.{v}" for k, v in match.items()])
        url = f"{url}?{filters}"

    headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    }

    # Only add upsert header for POST
    if method == 'POST':
        headers['Prefer'] = 'resolution=merge-duplicates,return=minimal'

    try:
        print(f"🌐 Backend calling Supabase at: {url}")
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode('utf-8'),
            headers=headers,
            method=method
        )
        with urllib.request.urlopen(req) as resp:
            pass
        print(f"✅ Supabase {method} on '{table}' OK")
    except urllib.error.HTTPError as e:
        try:
            error_body = e.read().decode('utf-8')
        except Exception:
            error_body = str(e)
        print(f"❌ Supabase HTTP {e.code} error on '{table}': {error_body}")
    except Exception as e:
        print(f"❌ Supabase connection error on '{table}': {e}")


def update_tank_in_supabase(product, station_id, new_level_ml):
    """Update tank level directly in Supabase for a given product and station_id"""
    try:
        url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/tanks?station_id=eq.{station_id}&or=(product.eq.{product},liquid.eq.{product})&select=id,current_level_ml,level"
        headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
            'Content-Type': 'application/json'
        }
        req = urllib.request.Request(url, headers=headers, method='GET')
        with urllib.request.urlopen(req) as resp:
            tanks = json.loads(resp.read().decode('utf-8'))

        now_iso = datetime.datetime.utcnow().isoformat() + 'Z'
        if tanks and len(tanks) > 0:
            tank_id = tanks[0]['id']
            patch_url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/tanks?id=eq.{tank_id}"
            patch_data = json.dumps({
                'current_level_ml': new_level_ml,
                'level': new_level_ml,
                'updated_at': now_iso
            }).encode('utf-8')
            patch_headers = {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            }
            patch_req = urllib.request.Request(patch_url, data=patch_data, headers=patch_headers, method='PATCH')
            with urllib.request.urlopen(patch_req) as resp:
                pass
            print(f"✅ Supabase tank '{product}' set to {new_level_ml}ml (row ID {tank_id})")
        else:
            sync_to_supabase('tanks', {
                'station_id': station_id,
                'product': product,
                'liquid': product,
                'current_level_ml': new_level_ml,
                'level': new_level_ml,
                'capacity_ml': 5000,
                'tank_max': 5000,
                'updated_at': now_iso
            })
            print(f"✅ Supabase new tank '{product}' created at {new_level_ml}ml")

        # Update in-memory DB_STATE
        with db_lock:
            tanks = get_by_path(DB_STATE, f'stations/{station_id}/tanks') or {}
            tanks[product] = new_level_ml
            set_by_path(DB_STATE, f'stations/{station_id}/tanks', tanks)
        save_db()

        # If tank was refilled / non-zero, auto-resolve any pending supplier orders for this product
        if new_level_ml > 0:
            try:
                ord_url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/orders?status=eq.pending&or=(product.eq.{product},liquid.eq.{product})"
                ord_headers = {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                }
                ord_patch = json.dumps({'status': 'delivered'}).encode('utf-8')
                ord_req = urllib.request.Request(ord_url, data=ord_patch, headers=ord_headers, method='PATCH')
                with urllib.request.urlopen(ord_req) as resp:
                    pass
                print(f"✅ Auto-resolved pending supplier orders for '{product}' (tank level: {new_level_ml}ml)")
            except Exception as e:
                print(f"⚠️ Auto-resolve pending orders notice: {e}")

        return new_level_ml
    except Exception as e:
        print(f"⚠️ Tank update error: {e}")
        return None


def refill_tank_in_supabase(product, station_id, amount_added_ml, admin_user='Admin'):
    """Add amount_added_ml to tank, capped at capacity (5000ml), update updated_at, clear pending orders, log refill event"""
    try:
        url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/tanks?station_id=eq.{station_id}&or=(product.eq.{product},liquid.eq.{product})&select=id,current_level_ml,level,capacity_ml,tank_max"
        headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
            'Content-Type': 'application/json'
        }
        req = urllib.request.Request(url, headers=headers, method='GET')
        with urllib.request.urlopen(req) as resp:
            tanks = json.loads(resp.read().decode('utf-8'))

        now_iso = datetime.datetime.utcnow().isoformat() + 'Z'
        current = 0.0
        tank_id = None
        max_cap = 5000.0

        if tanks and len(tanks) > 0:
            tank_id = tanks[0]['id']
            current = float(tanks[0].get('current_level_ml') if tanks[0].get('current_level_ml') is not None else (tanks[0].get('level') or 0))
            max_cap = float(tanks[0].get('capacity_ml') or tanks[0].get('tank_max') or 5000)

        new_level = min(max_cap, current + amount_added_ml)

        if tank_id:
            patch_url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/tanks?id=eq.{tank_id}"
            patch_data = json.dumps({
                'current_level_ml': new_level,
                'level': new_level,
                'updated_at': now_iso
            }).encode('utf-8')
            patch_headers = {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            }
            patch_req = urllib.request.Request(patch_url, data=patch_data, headers=patch_headers, method='PATCH')
            with urllib.request.urlopen(patch_req) as resp:
                pass

        # Auto-clear any pending supplier order for this product
        try:
            ord_url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/orders?status=eq.pending&or=(product.eq.{product},liquid.eq.{product})"
            ord_headers = {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            }
            ord_patch = json.dumps({'status': 'delivered'}).encode('utf-8')
            ord_req = urllib.request.Request(ord_url, data=ord_patch, headers=ord_headers, method='PATCH')
            with urllib.request.urlopen(ord_req) as resp:
                pass
            print(f"✅ Auto-resolved pending supplier orders for '{product}' on tank refill")
        except Exception:
            pass

        # Log audit trail to tank_refills table with fallback to orders table
        try:
            refill_url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/tank_refills"
            refill_data = json.dumps({
                'station_id': station_id,
                'product': product,
                'amount_added_ml': amount_added_ml,
                'new_level_ml': new_level,
                'admin_user': admin_user,
                'created_at': now_iso
            }).encode('utf-8')
            refill_headers = {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            }
            refill_req = urllib.request.Request(refill_url, data=refill_data, headers=refill_headers, method='POST')
            with urllib.request.urlopen(refill_req) as resp:
                pass
            print(f"Refill event logged to tank_refills table for '{product}' (+{amount_added_ml}ml)")
        except Exception:
            sync_to_supabase('orders', {
                'station_id': station_id,
                'product': product,
                'liquid': product,
                'quantity_ml': amount_added_ml,
                'quantity': amount_added_ml / 1000.0,
                'price': 0,
                'status': 'fulfilled',
                'trigger_type': 'refill',
                'created_at': now_iso
            })
            print(f"Refill audit event logged to orders table for '{product}' (+{amount_added_ml}ml)")

        # Update in-memory state
        with db_lock:
            tanks_dict = get_by_path(DB_STATE, f'stations/{station_id}/tanks') or {}
            tanks_dict[product] = new_level
            set_by_path(DB_STATE, f'stations/{station_id}/tanks', tanks_dict)
        save_db()

        print(f"✅ Tank '{product}' refilled +{amount_added_ml}ml → {new_level}ml (updated_at: {now_iso})")
        return new_level
    except Exception as e:
        print(f"⚠️ Refill tank error: {e}")
        return None



def decrement_tank_in_supabase(product, station_id, qty_ml):
    """Read current tank level from Supabase, subtract qty_ml, write back via PATCH"""
    try:
        url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/tanks?station_id=eq.{station_id}&or=(product.eq.{product},liquid.eq.{product})&select=id,current_level_ml,level"
        headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
            'Content-Type': 'application/json'
        }
        req = urllib.request.Request(url, headers=headers, method='GET')
        with urllib.request.urlopen(req) as resp:
            tanks = json.loads(resp.read().decode('utf-8'))

        if tanks and len(tanks) > 0:
            current = float(tanks[0].get('current_level_ml') if tanks[0].get('current_level_ml') is not None else (tanks[0].get('level') or 5000))
            new_level = max(0.0, current - qty_ml)
            update_tank_in_supabase(product, station_id, new_level)
            return new_level
        else:
            return update_tank_in_supabase(product, station_id, max(0.0, 5000 - qty_ml))
    except Exception as e:
        print(f"⚠️ Tank decrement error: {e}")
        return None


def increment_user_points_in_supabase(uid, pts_to_add, email='', name=''):
    """Read current points from Supabase, add pts_to_add, write back via PATCH"""
    try:
        url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/users?id=eq.{uid}&select=points"
        headers = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
            'Content-Type': 'application/json'
        }
        req = urllib.request.Request(url, headers=headers, method='GET')
        with urllib.request.urlopen(req) as resp:
            users = json.loads(resp.read().decode('utf-8'))

        if users and len(users) > 0:
            current_pts = int(users[0].get('points', 0) or 0)
            new_total = current_pts + pts_to_add
            sync_to_supabase(
                'users',
                {'points': new_total},
                method='PATCH',
                match={'id': uid}
            )
            print(f"✅ User {uid} points: {current_pts} + {pts_to_add} = {new_total}")
        else:
            sync_to_supabase('users', {
                'id': uid,
                'email': email,
                'name': name,
                'points': pts_to_add
            })
    except Exception as e:
        print(f"⚠️ Points increment error: {e}")

# ==========================================
# 📧 UNIFIED EMAIL DISPATCHER
# ==========================================
def send_email_via_resend(api_key, to_email, subject, html_content, from_name="RefillX", from_email=None):
    from_addr = f"{from_name} <{from_email or 'onboarding@resend.dev'}>"
    url = 'https://api.resend.com/emails'
    payload = json.dumps({
        'from': from_addr,
        'to': [to_email],
        'subject': subject,
        'html': html_content
    }).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
            'User-Agent': 'RefillX-Server/1.0'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=8) as response:
        return True, response.read().decode('utf-8')

def send_email_via_brevo(api_key, to_email, subject, html_content, from_name="RefillX", from_email=None):
    from_addr = from_email or SENDER_EMAIL or 'noreply@refillx.com'
    url = 'https://api.brevo.com/v3/smtp/email'
    payload = json.dumps({
        'sender': {'name': from_name, 'email': from_addr},
        'to': [{'email': to_email}],
        'subject': subject,
        'htmlContent': html_content
    }).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            'api-key': api_key,
            'Content-Type': 'application/json'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=8) as response:
        return True, response.read().decode('utf-8')

def send_email_via_sendgrid(api_key, to_email, subject, html_content, from_name="RefillX", from_email=None):
    from_addr = from_email or SENDER_EMAIL or 'noreply@refillx.com'
    url = 'https://api.sendgrid.com/v3/mail/send'
    payload = json.dumps({
        'personalizations': [{'to': [{'email': to_email}]}],
        'from': {'email': from_addr, 'name': from_name},
        'subject': subject,
        'content': [{'type': 'text/html', 'value': html_content}]
    }).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=8) as response:
        return True, 'OK'

def send_email_via_smtp(to_email, subject, html_content, from_name="RefillX"):
    if not SENDER_EMAIL or not SENDER_PASSWORD:
        return False, "SENDER_EMAIL or SENDER_PASSWORD not set"
    
    msg = MIMEMultipart()
    msg['From'] = f"{from_name} <{SENDER_EMAIL}>"
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(html_content, 'html'))
    
    # 1. Try STARTTLS on port 587 with strict 4-second timeout
    try:
        server = smtplib.SMTP('smtp.gmail.com', 587, timeout=4)
        server.starttls()
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        server.send_message(msg)
        server.quit()
        return True, "Sent via SMTP 587"
    except Exception as e587:
        # 2. Try SSL on port 465 with strict 4-second timeout
        try:
            server = smtplib.SMTP_SSL('smtp.gmail.com', 465, timeout=4)
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.send_message(msg)
            server.quit()
            return True, "Sent via SMTP SSL 465"
        except Exception as e465:
            return False, f"SMTP 587 ({e587}), SMTP 465 ({e465})"

def dispatch_email(to_email, subject, html_content, from_name="RefillX"):
    """
    Sends email via HTTP API (Resend, Brevo, SendGrid) or SMTP with strict timeout.
    Returns (success: bool, status_message: str)
    """
    if RESEND_API_KEY:
        try:
            ok, res = send_email_via_resend(RESEND_API_KEY, to_email, subject, html_content, from_name=from_name)
            if ok:
                print(f"✅ Email delivered to {to_email} via Resend HTTP API")
                return True, "Delivered via Resend HTTP API"
        except Exception as e:
            print(f"⚠️ Resend HTTP API error: {e}")

    if BREVO_API_KEY:
        try:
            ok, res = send_email_via_brevo(BREVO_API_KEY, to_email, subject, html_content, from_name=from_name)
            if ok:
                print(f"✅ Email delivered to {to_email} via Brevo HTTP API")
                return True, "Delivered via Brevo HTTP API"
        except Exception as e:
            print(f"⚠️ Brevo HTTP API error: {e}")

    if SENDGRID_API_KEY:
        try:
            ok, res = send_email_via_sendgrid(SENDGRID_API_KEY, to_email, subject, html_content, from_name=from_name)
            if ok:
                print(f"✅ Email delivered to {to_email} via SendGrid HTTP API")
                return True, "Delivered via SendGrid HTTP API"
        except Exception as e:
            print(f"⚠️ SendGrid HTTP API error: {e}")

    if SENDER_EMAIL and SENDER_PASSWORD:
        ok, msg = send_email_via_smtp(to_email, subject, html_content, from_name=from_name)
        if ok:
            print(f"✅ Email delivered to {to_email} via SMTP")
            return True, "Delivered via SMTP"
        else:
            print(f"⚠️ SMTP delivery failed: {msg}")
            return False, msg

    return False, "No working email transport configured or reachable"
# ==========================================

PORT = int(os.getenv('PORT', 8080))
HOST = '0.0.0.0'

DB_FILE = 'local_db.json'
db_lock = threading.Lock()

# Initial empty state
DB_STATE = {
    'stations': {
        'RFX-001': {
            'tanks': { 'water': 5000, 'shampoo': 5000, 'detergent': 5000, 'handwash': 5000, 'oil': 5000 },
            'health': { 'lastPing': 0, 'sensors': {
                'ultrasonic':  { 'status': 'ok', 'lastReading': '12.4 cm', 'lastUpdate': 0 },
                'flowSensor':  { 'status': 'ok', 'lastReading': '0 L/min', 'lastUpdate': 0 },
                'temperature': { 'status': 'ok', 'lastReading': '24.5 °C', 'lastUpdate': 0 },
                'tds':         { 'status': 'ok', 'lastReading': '180 ppm', 'lastUpdate': 0 },
                'qrScanner':   { 'status': 'ok', 'lastReading': 'Ready', 'lastUpdate': 0 }
            } },
            'dispense': { 'status': 'idle', 'progress': 0 }
        }
    },
    'settings': {
        'prices': {}
    },
    'logs': {
        'sessions': {}
    },
    'users': {},
    'sessions': {},
    'orders': {}
}

def load_db():
    global DB_STATE
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
                DB_STATE.update(loaded)
        except Exception as e:
            print("Error loading DB:", e)

def save_db():
    with db_lock:
        with open(DB_FILE, 'w', encoding='utf-8') as f:
            json.dump(DB_STATE, f)

load_db()

def deep_update(d, u):
    for k, v in u.items():
        if isinstance(v, dict) and k in d and isinstance(d[k], dict):
            deep_update(d[k], v)
        else:
            d[k] = v

def get_by_path(d, path):
    keys = [k for k in path.split('/') if k]
    curr = d
    for k in keys:
        if isinstance(curr, dict) and k in curr:
            curr = curr[k]
        else:
            return None
    return curr

def set_by_path(d, path, val):
    keys = [k for k in path.split('/') if k]
    if not keys: return
    curr = d
    for k in keys[:-1]:
        if k not in curr or not isinstance(curr[k], dict):
            curr[k] = {}
        curr = curr[k]
    curr[keys[-1]] = val

class KioskHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # CORS: allow configured origin (e.g. '*' or specific domain)
        self.send_header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        parsed_path = urlparse(self.path)

        # 1. Config endpoint serving non-secret client configuration as JSON
        if parsed_path.path == '/api/config':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'supabaseUrl': SUPABASE_URL,
                'supabaseAnonKey': SUPABASE_ANON_KEY,
                'adminPasscodeRequired': bool(ADMIN_PASSCODE)
            }).encode('utf-8'))

        # 2. Dynamic config.js script serving at request time
        elif parsed_path.path == '/config.js':
            js_content = f"""// Dynamically injected by server.py at request time
window.SUPABASE_URL = {json.dumps(SUPABASE_URL)};
window.SUPABASE_ANON_KEY = {json.dumps(SUPABASE_ANON_KEY)};
window.SUPABASE_CONFIG_PROMISE = Promise.resolve({{
  supabaseUrl: window.SUPABASE_URL,
  supabaseAnonKey: window.SUPABASE_ANON_KEY
}});
console.log("⚡ RefillX Config Injected by Server:", {{
  supabaseUrl: window.SUPABASE_URL ? (window.SUPABASE_URL.substring(0, 15) + "...") : "❌ EMPTY",
  supabaseAnonKey: window.SUPABASE_ANON_KEY ? (window.SUPABASE_ANON_KEY.length + " chars") : "❌ EMPTY"
}});
"""
            self.send_response(200)
            self.send_header('Content-type', 'application/javascript; charset=utf-8')
            self.end_headers()
            self.wfile.write(js_content.encode('utf-8'))

        # 3. Dynamic HTML templating: Inject window.SUPABASE_URL and SUPABASE_ANON_KEY into HTML pages at request time
        elif parsed_path.path.endswith('.html') or parsed_path.path in ['/', '']:
            filename = parsed_path.path.lstrip('/')
            if not filename or filename == '/':
                filename = 'refillx-machine.html'
            if os.path.exists(filename):
                try:
                    with open(filename, 'r', encoding='utf-8') as f:
                        html_content = f.read()
                    
                    injection = f"""<script>
  window.SUPABASE_URL = {json.dumps(SUPABASE_URL)};
  window.SUPABASE_ANON_KEY = {json.dumps(SUPABASE_ANON_KEY)};
  window.SUPABASE_CONFIG_PROMISE = Promise.resolve({{
    supabaseUrl: window.SUPABASE_URL,
    supabaseAnonKey: window.SUPABASE_ANON_KEY
  }});
</script>"""
                    if '</head>' in html_content:
                        html_content = html_content.replace('</head>', f'{injection}\n</head>', 1)
                    else:
                        html_content = injection + html_content

                    self.send_response(200)
                    self.send_header('Content-type', 'text/html; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(html_content.encode('utf-8'))
                    return
                except Exception as e:
                    print(f"Error dynamically serving HTML file {filename}:", e)


        # Original status endpoint for old logic (if any)
        elif parsed_path.path == '/status':
            qs = parse_qs(parsed_path.query)
            sid = qs.get('sid', [''])[0]
            # fallback mock
            status = 'unknown'
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': status}).encode('utf-8'))

        # LOCAL CLOUD SERVER ENDPOINTS
        elif parsed_path.path == '/api/health':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok', 'server': 'refillx-local'}).encode('utf-8'))

        elif parsed_path.path == '/api/sync':
            # Returns the entire DB state
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(DB_STATE).encode('utf-8'))

        elif parsed_path.path == '/api/get':
            qs = parse_qs(parsed_path.query)
            path = qs.get('path', [''])[0]
            val = get_by_path(DB_STATE, path)
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'value': val}).encode('utf-8'))

        else:
            super().do_GET()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        parsed_path = urlparse(self.path)

        if parsed_path.path in ['/api/set', '/api/update', '/api/push']:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)

            try:
                data = json.loads(post_data.decode('utf-8'))
                path = data.get('path', '')
                value = data.get('data')

                with db_lock:
                    if parsed_path.path == '/api/set':
                        if path == '/':
                            global DB_STATE
                            DB_STATE = value
                        else:
                            set_by_path(DB_STATE, path, value)

                    elif parsed_path.path == '/api/update':
                        # update implies merging at the specific path
                        curr = get_by_path(DB_STATE, path)
                        if curr is None or not isinstance(curr, dict):
                            set_by_path(DB_STATE, path, value)
                        else:
                            # if it's a dict, deep update
                            if isinstance(value, dict):
                                deep_update(curr, value)
                            else:
                                set_by_path(DB_STATE, path, value)

                    elif parsed_path.path == '/api/push':
                        curr = get_by_path(DB_STATE, path)
                        if curr is None or not isinstance(curr, dict):
                            set_by_path(DB_STATE, path, {})
                            curr = get_by_path(DB_STATE, path)

                        push_id = "-L" + str(int(time.time() * 1000)) + "X"
                        curr[push_id] = value

                # Async save
                threading.Thread(target=save_db).start()

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
            except Exception as e:
                print("API ERROR:", e)
                self.send_response(500)
                self.end_headers()

        elif parsed_path.path == '/api/payment-confirm':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8'))
                if 'data' in payload: payload = payload['data']
                sid = payload.get('sessionId') or payload.get('sid') or payload.get('id')
                status = payload.get('status', 'paid')

                if sid:
                    with db_lock:
                        session = get_by_path(DB_STATE, f'sessions/{sid}')
                        if not session:
                            session = {'order': {}, 'status': status}
                            set_by_path(DB_STATE, f'sessions/{sid}', session)

                        session['status'] = status
                        session['paid_at'] = datetime.datetime.utcnow().isoformat() + 'Z'

                        ord_data = session.get('order', {}) or {}
                        auth_data = session.get('authData', {}) or {}
                        uid = ord_data.get('uid') or session.get('user_id') or session.get('uid') or session.get('userId') or auth_data.get('uid') or auth_data.get('id')
                        if not uid or uid == 'Guest' or uid == 'UID-GUEST':
                            uid = None
                        prod_key = ord_data.get('prod') or session.get('product') or session.get('prod') or 'shampoo'
                        qty_ml = int(ord_data.get('qty') or session.get('quantity_ml') or session.get('qty') or 500)
                        order_total = float(ord_data.get('amt') or session.get('amount') or session.get('amt') or 0.0)

                        ML_PER_BOTTLE = 500
                        bottles_saved = qty_ml // ML_PER_BOTTLE
                        base_points = (qty_ml // 100) * 10
                        bottle_bonus = bottles_saved * 25
                        points_earned = base_points + bottle_bonus

                        # Create Order object in DB_STATE
                        order_id = "ORD-" + str(uuid.uuid4())[:8].upper()
                        if 'orders' not in DB_STATE or not isinstance(DB_STATE['orders'], dict):
                            DB_STATE['orders'] = {}
                        DB_STATE['orders'][order_id] = {
                            'id': order_id,
                            'order_id': order_id,
                            'session_id': sid,
                            'user_id': uid,
                            'product': prod_key,
                            'liquid': prod_key,
                            'quantity_ml': qty_ml,
                            'quantity': qty_ml / 1000.0,
                            'price': order_total,
                            'amount': order_total,
                            'status': 'completed',
                            'trigger_type': 'manual',
                            'created_at': int(time.time() * 1000)
                        }

                    # Sync to Supabase in background
                    def run_payment_confirm_sync():
                        sync_to_supabase('sessions', {
                            'id': sid,
                            'user_id': uid,
                            'station_id': 'RFX-001',
                            'product': prod_key,
                            'quantity_ml': qty_ml,
                            'amount': order_total,
                            'points_earned': points_earned,
                            'status': 'complete',
                            'created_at': datetime.datetime.utcnow().isoformat() + 'Z'
                        })
                        sync_to_supabase('orders', {
                            'session_id': sid,
                            'user_id': uid,
                            'product': prod_key,
                            'liquid': prod_key,
                            'quantity_ml': qty_ml,
                            'quantity': qty_ml / 1000.0,
                            'price': order_total,
                            'points_earned': points_earned,
                            'status': 'completed',
                            'created_at': datetime.datetime.utcnow().isoformat() + 'Z'
                        })
                        decrement_tank_in_supabase(prod_key, 'RFX-001', qty_ml)
                        if uid and uid != 'Guest' and uid != 'UID-GUEST':
                            increment_user_points_in_supabase(uid, points_earned)
                    threading.Thread(target=run_payment_confirm_sync, daemon=True).start()

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

        elif parsed_path.path == '/api/call/sendReceipt':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8'))
                if 'data' in payload: payload = payload['data']

                user_email = payload.get('email', '')
                user_name = payload.get('name', 'Customer')
                product = payload.get('product', 'Dispense')
                volume = payload.get('volume', '500ml')
                price = payload.get('price', '₹0.00')
                date_time = payload.get('date_time', time.strftime('%Y-%m-%d %H:%M:%S'))
                txn = payload.get('txn', 'TXN-' + str(int(time.time())))

                html_body = f"""
                <html>
                  <body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #2d9e5f;">RefillX Dispense Receipt 🌿</h2>
                    <p>Hi <strong>{user_name}</strong>,</p>
                    <p>Thank you for refilling with RefillX! Here are your transaction details:</p>
                    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                      <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Transaction ID:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{txn}</td></tr>
                      <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Product:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{product}</td></tr>
                      <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Volume:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{volume}</td></tr>
                      <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Amount Paid:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{price}</td></tr>
                      <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Date & Time:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{date_time}</td></tr>
                    </table>
                    <p style="color: #2d9e5f; font-weight: bold;">Thank you for saving plastic bottles! 🌱</p>
                  </body>
                </html>
                """

                def do_send():
                    dispatch_email(
                        to_email=user_email,
                        subject=f"RefillX Receipt — Order #{txn}",
                        html_content=html_body,
                        from_name="RefillX"
                    )

                threading.Thread(target=do_send, daemon=True).start()

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True, 'email': user_email}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

        elif parsed_path.path == '/api/set-tank':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                body = json.loads(post_data.decode('utf-8'))
                product = body.get('product') or body.get('liquid')
                level_ml = float(body.get('level_ml') if body.get('level_ml') is not None else (body.get('current_level_ml') if body.get('current_level_ml') is not None else 0))
                station_id = body.get('station_id', 'RFX-001')

                updated = update_tank_in_supabase(product, station_id, level_ml)

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True, 'product': product, 'level_ml': updated}).encode('utf-8'))
                return
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))
                return

        elif parsed_path.path == '/api/refill-tank':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                body = json.loads(post_data.decode('utf-8'))
                product = body.get('product') or body.get('liquid')
                amount_added = float(body.get('amount_added_ml') or body.get('amount') or 1000)
                station_id = body.get('station_id', 'RFX-001')
                admin_user = body.get('admin_user', 'Admin')

                new_level = refill_tank_in_supabase(product, station_id, amount_added, admin_user)

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True, 'product': product, 'amount_added_ml': amount_added, 'new_level_ml': new_level}).encode('utf-8'))
                return
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))
                return

        elif parsed_path.path == '/api/sync':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                session_data = json.loads(post_data.decode('utf-8'))
                if 'data' in session_data: session_data = session_data['data']

                sid = session_data.get('sessionId') or session_data.get('id') or session_data.get('sid') or ("RFX-" + str(uuid.uuid4())[:8].upper())
                uid = session_data.get('userId') or session_data.get('user_id') or session_data.get('uid') or 'Guest'
                product = session_data.get('product') or session_data.get('prod') or 'shampoo'
                qty_ml = int(session_data.get('quantityMl') or session_data.get('quantity_ml') or session_data.get('qty') or 500)
                amount = float(session_data.get('amount') or session_data.get('amt') or 0.0)
                short_code = str(session_data.get('shortCode') or session_data.get('short_code') or '').strip()
                status = session_data.get('status') or 'complete'
                pts = int(qty_ml / 100)

                with db_lock:
                    if 'sessions' not in DB_STATE or not isinstance(DB_STATE['sessions'], dict):
                        DB_STATE['sessions'] = {}
                    DB_STATE['sessions'][sid] = {
                        'order': session_data,
                        'status': status,
                        'sessionId': sid,
                        'user_id': uid,
                        'product': product,
                        'quantity_ml': qty_ml,
                        'amount': amount,
                        'points_earned': pts,
                        'short_code': short_code,
                        'created_at': int(time.time() * 1000)
                    }

                def run_sync():
                    sync_to_supabase('sessions', {
                        'id': sid,
                        'user_id': uid,
                        'station_id': 'RFX-001',
                        'product': product,
                        'quantity_ml': qty_ml,
                        'amount': amount,
                        'points_earned': pts,
                        'status': status,
                        'short_code': short_code,
                        'created_at': datetime.datetime.utcnow().isoformat() + 'Z'
                    })
                    sync_to_supabase('orders', {
                        'session_id': sid,
                        'user_id': uid,
                        'product': product,
                        'quantity_ml': qty_ml,
                        'price': amount,
                        'status': 'completed',
                        'created_at': datetime.datetime.utcnow().isoformat() + 'Z'
                    })
                    decrement_tank_in_supabase(product, 'RFX-001', qty_ml)
                    increment_user_points_in_supabase(uid, pts)
                threading.Thread(target=run_sync, daemon=True).start()

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

        elif parsed_path.path == '/api/call/finalizePayment':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8')).get('data', {})
                sid = payload.get('sid')
                uid = payload.get('uid')
                use_points = payload.get('usePoints', False)
                client_total = payload.get('clientTotal', 0)

                order_id = "ORD-" + str(uuid.uuid4())[:8].upper()
                user_email = ""
                user_name = "Customer"
                prod_key = "shampoo"
                qty_ml = 500

                PRODUCT_KEY_MAP = {
                    'shampoo': 'shampoo', 'Shampoo': 'shampoo',
                    'handwash': 'handwash', 'Handwash': 'handwash',
                    'detergent': 'detergent', 'Liquid Detergent': 'detergent', 'liquid detergent': 'detergent',
                    'water': 'water', 'RO Water': 'water', 'ro water': 'water',
                    'oil': 'oil', 'Cooking Oil': 'oil', 'cooking oil': 'oil'
                }

                with db_lock:
                    session = get_by_path(DB_STATE, f'sessions/{sid}')
                    if not session:
                        session = {'order': {}, 'status': 'complete'}
                        set_by_path(DB_STATE, f'sessions/{sid}', session)

                    ord_data = session.get('order', {}) or {}
                    auth_data = session.get('authData', {}) or {}
                    if not uid or uid == 'Guest' or uid == 'UID-GUEST':
                        uid = ord_data.get('uid') or session.get('user_id') or session.get('uid') or session.get('userId') or auth_data.get('uid') or auth_data.get('id')
                    
                    if not uid or uid == 'Guest' or uid == 'UID-GUEST':
                        uid = None

                    print(f"📦 [finalizePayment] Processing order for session '{sid}', user_id '{uid}'")

                    user = get_by_path(DB_STATE, f'users/{uid}') if uid else None
                    if not user:
                        user = {'pointsBalance': 0, 'history': {}, 'email': '', 'name': 'Customer'}
                        if uid:
                            set_by_path(DB_STATE, f'users/{uid}', user)

                    user_email = user.get('email', '')
                    user_name = user.get('name', 'Customer')

                    ord_data = session.get('order', {}) or {}
                    raw_prod = ord_data.get('prod') or session.get('product') or session.get('prod') or 'shampoo'
                    prod_key = PRODUCT_KEY_MAP.get(str(raw_prod), str(raw_prod).lower().replace(' ', '_'))

                    raw_qty = ord_data.get('qty') or session.get('quantity_ml') or session.get('qty') or 500
                    try:
                        qty_ml = int(float(str(raw_qty)))
                    except (ValueError, TypeError):
                        qty_ml = 500

                    raw_total = ord_data.get('amt') or session.get('amount') or session.get('amt') or client_total or 0
                    try:
                        order_total = float(str(raw_total))
                    except (ValueError, TypeError):
                        order_total = float(client_total or 0)

                    points_balance = user.get('pointsBalance', 0) or 0
                    points_redeemed = 0

                    if use_points and points_balance > 0:
                        points_redeemed = min(float(points_balance) * 0.02, order_total)
                        user['pointsBalance'] = float(points_balance) - (points_redeemed / 0.02)

                    final_amount = max(0.0, order_total - points_redeemed)

                    # Eco Points Formula (agreed):
                    # base_points = floor(qty_ml / 100) * 10  → 10 pts per 100ml
                    # bottle_bonus = floor(qty_ml / 500) * 25 → 25 pts per plastic bottle avoided (1 bottle ≈ 500ml)
                    # total = base_points + bottle_bonus
                    ML_PER_BOTTLE = 500          # 1 plastic bottle ≈ 500ml
                    ECO_PTS_PER_100ML = 10        # base: 10 points per 100ml dispensed
                    ECO_PTS_PER_BOTTLE = 25       # bonus: 25 points per plastic bottle avoided
                    bottles_saved = qty_ml // ML_PER_BOTTLE
                    base_points = (qty_ml // 100) * ECO_PTS_PER_100ML
                    bottle_bonus = bottles_saved * ECO_PTS_PER_BOTTLE
                    points_earned = base_points + bottle_bonus
                    user['pointsBalance'] = float(user.get('pointsBalance', 0) or 0) + points_earned

                    now_ts = int(time.time() * 1000)

                    # Update Session object schema
                    session['status'] = 'complete'
                    session['user_id'] = uid
                    session['station_id'] = 'RFX-001'
                    session['product'] = prod_key
                    session['quantity_ml'] = qty_ml
                    session['amount'] = final_amount
                    session['created_at'] = now_ts
                    session['finalAmount'] = final_amount
                    session['pointsRedeemed'] = points_redeemed
                    session['pointsEarned'] = points_earned

                    # 1. DB Write: Orders table
                    if 'orders' not in DB_STATE or not isinstance(DB_STATE['orders'], dict):
                        DB_STATE['orders'] = {}
                    DB_STATE['orders'][order_id] = {
                        'id': order_id,
                        'order_id': order_id,
                        'session_id': sid,
                        'user_id': uid,
                        'product': prod_key,
                        'liquid': prod_key,
                        'quantity_ml': qty_ml,
                        'quantity': qty_ml / 1000.0,
                        'price': final_amount,
                        'amount': final_amount,
                        'status': 'completed',
                        'trigger_type': 'manual',
                        'created_at': now_ts
                    }

                    # 2. DB Write: Decrement Tanks table (safe access)
                    tanks = get_by_path(DB_STATE, 'stations/RFX-001/tanks') or {}
                    current_tank_level = float(tanks.get(prod_key, 5000))
                    new_tank_level = max(0.0, current_tank_level - qty_ml)
                    if prod_key in tanks:
                        tanks[prod_key] = new_tank_level

                    # User History write
                    history = user.get('history', {}) or {}
                    txn_id = "TXN-" + str(uuid.uuid4())[:8].upper()
                    history[txn_id] = {
                        'timestamp': now_ts,
                        'quantity': qty_ml,
                        'productName': prod_key,
                        'amountPaid': final_amount,
                        'pointsRedeemed': points_redeemed,
                        'pointsEarned': points_earned
                    }
                    user['history'] = history

                threading.Thread(target=save_db).start()

                # Sync to Supabase in background
                def run_payment_supabase_sync():
                    sync_to_supabase('sessions', {
                        'id': sid,
                        'user_id': uid,
                        'station_id': 'RFX-001',
                        'product': prod_key,
                        'quantity_ml': qty_ml,
                        'amount': final_amount,
                        'points_earned': points_earned,
                        'status': 'complete',
                        'short_code': str(session.get('shortCode') or session.get('short_code') or '').strip(),
                        'created_at': datetime.datetime.utcnow().isoformat() + 'Z'
                    })
                    sync_to_supabase('orders', {
                        'session_id': sid,
                        'user_id': uid,
                        'product': prod_key,
                        'quantity_ml': qty_ml,
                        'price': final_amount,
                        'status': 'completed',
                        'created_at': datetime.datetime.utcnow().isoformat() + 'Z'
                    })
                    decrement_tank_in_supabase(prod_key, 'RFX-001', qty_ml)
                    increment_user_points_in_supabase(uid, points_earned, user_email, user_name)
                threading.Thread(target=run_payment_supabase_sync, daemon=True).start()

                # 3. Trigger Email Receipt
                if user_email and SENDER_EMAIL and SENDER_PASSWORD:
                    def send_receipt_mail():
                        try:
                            msg = MIMEMultipart()
                            msg['From'] = f"RefillX <{SENDER_EMAIL}>"
                            msg['To'] = user_email
                            msg['Subject'] = f"RefillX Receipt — Order #{order_id}"

                            html_body = f"""
                            <html>
                              <body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                                <h2 style="color: #2d9e5f;">RefillX Dispense Receipt 🌿</h2>
                                <p>Hi <strong>{user_name}</strong>,</p>
                                <p>Thank you for refilling with RefillX! Here are your transaction details:</p>
                                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                                  <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Order ID:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{order_id}</td></tr>
                                  <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Session ID:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{sid}</td></tr>
                                  <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Station ID:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">RFX-001</td></tr>
                                  <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Product:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{prod_key.capitalize()}</td></tr>
                                  <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Quantity:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{qty_ml} ml</td></tr>
                                  <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Amount Paid:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">₹{final_amount:.2f}</td></tr>
                                  <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Date & Time:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">{time.strftime('%Y-%m-%d %H:%M:%S')}</td></tr>
                                </table>
                                <p style="color: #2d9e5f; font-weight: bold;">Thank you for saving plastic bottles! 🌱</p>
                              </body>
                            </html>
                            """
                            dispatch_email(
                                to_email=user_email,
                                subject=f"RefillX Receipt — Order #{order_id}",
                                html_content=html_body,
                                from_name="RefillX"
                            )
                        except Exception as em_err:
                            print(f"Failed to send receipt email to {user_email}: {em_err}")

                    threading.Thread(target=send_receipt_mail).start()

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True, 'order_id': order_id, 'email': user_email}).encode('utf-8'))
            except Exception as e:
                print("❌ finalizePayment CRASH:")
                traceback.print_exc()
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))


        elif parsed_path.path == '/api/call/verifyShortCode':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8'))
                if 'data' in payload: payload = payload['data']
                code = str(payload.get('code', '')).strip()

                found_sid = None
                found_session = None
                with db_lock:
                    sessions = DB_STATE.get('sessions', {})
                    for sid, s in sessions.items():
                        if isinstance(s, dict):
                            sc = str(s.get('shortCode') or s.get('short_code') or (s.get('order') or {}).get('shortCode') or '').strip()
                            if sc and sc == code:
                                found_sid = sid
                                found_session = s
                                break

                if found_sid:
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True, 'sessionId': found_sid, 'session': found_session}).encode('utf-8'))
                else:
                    self.send_response(404)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps({'error': 'Invalid or expired 6-digit code. Please try again.'}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

        elif parsed_path.path == '/api/call/sendEmailOtp':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8')).get('data', {})
                email = payload.get('email')
                if not email: raise Exception("Email required")

                otp = str(random.randint(100000, 999999))

                with db_lock:
                    otps = get_by_path(DB_STATE, 'emailOtps')
                    if not otps:
                        set_by_path(DB_STATE, 'emailOtps', {})
                        otps = get_by_path(DB_STATE, 'emailOtps')
                    otps[email] = {
                        'otp': otp,
                        'expiresAt': int(time.time() * 1000) + 600000  # 10 mins
                    }
                threading.Thread(target=save_db, daemon=True).start()

                html_content = f"""
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #0a140d; color: #ffffff; padding: 30px; border-radius: 16px; border: 1px solid #1e3a29;">
                  <h2 style="color: #3ecf7a; margin-top: 0;">RefillX Login Verification</h2>
                  <p style="color: #d1d5db; font-size: 15px;">Use the following 6-digit verification code to sign in to your RefillX account:</p>
                  <div style="background: #112217; border: 2px dashed #3ecf7a; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                    <span style="font-family: monospace; font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #3ecf7a;">{otp}</span>
                  </div>
                  <p style="color: #9ca3af; font-size: 13px; margin-bottom: 0;">This code will expire in 10 minutes. If you did not request this code, please ignore this email.</p>
                </div>
                """

                email_sent, send_info = dispatch_email(
                    to_email=email,
                    subject=f"Your RefillX Login Code: {otp}",
                    html_content=html_content,
                    from_name="RefillX"
                )

                response_body = {
                    'success': True,
                    'email_sent': email_sent,
                    'message': 'Code sent successfully' if email_sent else 'Code generated (Host blocks SMTP)'
                }

                if not email_sent:
                    print(f"📢 [OTP DEMO FALLBACK] Generated OTP for {email}: {otp} (Reason: {send_info})")
                    response_body['otp_demo'] = otp
                    response_body['notice'] = "Render Free Tier blocks SMTP. For live email delivery, set RESEND_API_KEY in Render."

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(response_body).encode('utf-8'))
            except Exception as e:
                print(f"❌ sendEmailOtp error: {e}")
                traceback.print_exc()
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

        elif parsed_path.path == '/api/call/verifyEmailOtp':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8')).get('data', {})
                email = payload.get('email')
                code = payload.get('code')
                old_uid = payload.get('oldUid')
                name = payload.get('name')
                mobile = payload.get('mobile')

                with db_lock:
                    otps = get_by_path(DB_STATE, 'emailOtps')
                    if not otps or email not in otps:
                        raise Exception("No OTP found")

                    otp_data = otps[email]
                    if int(time.time() * 1000) > otp_data['expiresAt']:
                        raise Exception("OTP Expired")

                    if otp_data['otp'] != code:
                        raise Exception("Invalid OTP")

                    del otps[email]

                    users = get_by_path(DB_STATE, 'users')
                    if not users:
                        set_by_path(DB_STATE, 'users', {})
                        users = get_by_path(DB_STATE, 'users')

                    existing_uid = None
                    for uid, udata in users.items():
                        if udata.get('email') == email:
                            existing_uid = uid
                            break

                    if existing_uid:
                        user_uid = existing_uid
                        users[user_uid]['name'] = name
                        users[user_uid]['mobile'] = mobile
                    else:
                        user_uid = "UID-" + str(uuid.uuid4())[:8].upper()
                        users[user_uid] = {
                            'email': email,
                            'name': name,
                            'mobile': mobile,
                            'pointsBalance': 0,
                            'history': {}
                        }

                    if old_uid and old_uid != user_uid and old_uid in users:
                        old_user = users[old_uid]
                        users[user_uid]['pointsBalance'] = users[user_uid].get('pointsBalance', 0) + old_user.get('pointsBalance', 0)
                        history = users[user_uid].get('history', {})
                        history.update(old_user.get('history', {}))
                        users[user_uid]['history'] = history
                        del users[old_uid]

                threading.Thread(target=save_db).start()

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True, 'uid': user_uid, 'token': 'mock-custom-token', 'user': users[user_uid]}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

        elif parsed_path.path == '/send-receipt':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                recipient = data.get('email')
                name = data.get('name')
                product = data.get('product')
                volume = data.get('volume')
                price = data.get('price')
                date_time = data.get('date_time')
                txn = data.get('txn')

                msg = MIMEMultipart()
                msg['From'] = f"RefillX Station <{SENDER_EMAIL}>"
                msg['To'] = recipient
                msg['Subject'] = f"Your RefillX Receipt: {product} ({volume})"

                html_content = f"""
                <html>
                  <body style="font-family: Arial, sans-serif; background-color: #060f09; color: #ffffff; padding: 40px; text-align: center;">
                    <div style="max-width: 500px; margin: 0 auto; background-color: #111111; padding: 40px; border: 2px dashed #3ecf7a; border-radius: 20px;">
                        <h2 style="color: #3ecf7a; font-size: 28px; font-weight: 900; margin-bottom: 5px;">REFILLX</h2>
                        <p style="color: #888888; margin-top: 0;">Eco-Park, Sector 5, BLR</p>
                        <hr style="border: 1px solid #333333; margin: 20px 0;">
                        <p style="text-align: left; margin: 5px 0;"><strong>Txn ID:</strong> <span style="float: right;">{txn}</span></p>
                        <p style="text-align: left; margin: 5px 0;"><strong>Date:</strong> <span style="float: right;">{date_time}</span></p>
                        <p style="text-align: left; margin: 5px 0;"><strong>Name:</strong> <span style="float: right;">{name}</span></p>
                        <hr style="border: 1px solid #333333; margin: 20px 0;">
                        <div style="text-align: left; font-size: 20px; font-weight: bold; margin-bottom: 20px;">
                            <span>{product} ({volume})</span>
                            <span style="float: right; color: #3ecf7a;">{price}</span>
                        </div>
                        <hr style="border: 1px solid #333333; margin: 20px 0;">
                        <p style="font-size: 16px; color: #3ecf7a;">Thank you for saving the planet! 🌍</p>
                    </div>
                  </body>
                </html>
                """
                dispatch_email(
                    to_email=recipient,
                    subject=f"Your RefillX Receipt: {product} ({volume})",
                    html_content=html_content,
                    from_name="RefillX Station"
                )

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
            except Exception as e:
                print(f"Failed to send email: {e}")
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
        else:
            super().do_POST()

class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    pass

with ThreadingTCPServer((HOST, PORT), KioskHandler) as httpd:
    print(f"RefillX Local Cloud Server running on {HOST}:{PORT} with Email support!")
    httpd.serve_forever()