# RefillX

IoT-enabled automated liquid and water dispensing infrastructure with progressive web application interface, cloud transaction backend, and predictive inventory analytics.

[ADD SCREENSHOT HERE]

## Problem It Solves
Single-use packaging generates significant plastic waste, while conventional automated vending machines lack unified real-time inventory telemetry and tamper-resistant offline dispensation validation. RefillX provides an end-to-end dispensing ecosystem where users locate stations and authorize refills via time-limited HMAC-signed QR tokens. The platform tracks volumetric consumption, detects hardware anomalies, and forecasts localized demand to prevent stockouts.

## Features
- Progressive Web Application with Offline Cache: Service worker and IndexedDB offline persistence that retains transaction history and profile data during network loss (`frontend/src/App.tsx`, `frontend/src/pages/Home.tsx`, `frontend/src/lib/firebase.ts`).
- Phone and Demo Authentication: Phone number OTP verification via Firebase Auth with invisible reCAPTCHA, Google Sign-In, and a test profile bypass for demonstrations (`frontend/src/pages/Login.tsx`).
- Station Discovery with Distance Calculation: Dispenser directory sorted dynamically using user geolocation and the Haversine formula (`frontend/src/pages/Refill.tsx`, `frontend/src/pages/Home.tsx`).
- HMAC-SHA256 Expiring QR Token Generation: 90-second expiring authorization tokens incorporating UID, dispenser ID, amount, timestamp, and cryptographic nonce (`frontend/src/pages/Refill.tsx`, `backend/functions/src/index.ts`).
- Prepaid Digital Wallet Management: Real-time balance synchronization, UPI top-up simulation, and bounded deposit enforcement between 10 INR and 10,000 INR with rate limiting (`frontend/src/pages/Wallet.tsx`, `backend/functions/src/index.ts`).
- Transaction Auditing and Receipts: Firestore transaction logging with automated PDF receipt generation uploaded to Firebase Storage with expiring signed URLs (`frontend/src/pages/History.tsx`, `backend/functions/src/index.ts`).
- Gamified Eco Passport and Tier System: Cumulative plastic and carbon offset tracking that generates a vector PDF Eco Passport when threshold refill counts are achieved (`frontend/src/pages/Profile.tsx`, `backend/functions/src/index.ts`).
- Multi-Sensor Telemetry and Fault Simulation: Real-time telemetry dashboard monitoring flow rate, ultrasonic distance, liquid temperature, tank percentage, and TDS with configurable hardware fault injection (`frontend/src/pages/Simulation.tsx`, `virtual_esp32.py`).
- Vendor Analytics Console: Telemetry metrics, status overrides, revenue charts, and inventory level monitoring (`frontend/src/pages/VendorDashboard.tsx`, `frontend/src/pages/Vendor.tsx`).
- Standalone Dispenser and Admin Interfaces: Single-page administrative dashboards with Leaflet maps, 7-day forecast visualizations, and standalone dispenser user interfaces (`admin-dashboard.html`, `admin.html`, `judge-demo.html`, `refillx-kiosk-pwa.html`, `refillx-machine.html`).
- Embedded Hardware Firmware: C++ FreeRTOS state machine managing ultrasonic proximity sensing, optical detection, pulse flow counting, solenoid valve relay control, and I2C/OLED status displays (`firmware/refillx-esp32/main.cpp`).
- Predictive Demand Forecasting: ARIMA and LSTM models estimating 7-day hourly consumption and calculating stockout risk (`refillx-ai/app/models/arima_model.py`, `refillx-ai/app/models/lstm_model.py`, `refillx-ai/app/routes/forecast.py`).
- Product Recommendations: Implicit collaborative filtering suggesting beverages and refill types based on prior transaction logs (`refillx-ai/app/models/collaborative_filter.py`, `refillx-ai/app/routes/recommend.py`).
- Customer Segmentation: K-Means clustering categorizing users by volume frequency and eco-point loyalty metrics (`refillx-ai/app/models/kmeans_model.py`, `refillx-ai/app/routes/segment.py`).
- Stockout Classification: Random Forest classifier calculating probability of depletion within a 48-hour window (`refillx-ai/app/models/random_forest.py`, `refillx-ai/app/routes/stock.py`).
- Dual-Write Database Server: Standalone Python HTTP socket server providing Supabase REST synchronization, local JSON database storage, and email delivery via Resend, Brevo, SendGrid, or SMTP (`server.py`).

## Tech Stack
### Frontend (PWA)
- React 18.3.1 (`frontend/package.json`)
- TypeScript 5.4.5 (`frontend/package.json`)
- Vite 5.2.11 (`frontend/package.json`)
- Firebase Web SDK 12.13.0 (`frontend/package.json`)
- Framer Motion 12.40.0 (`frontend/package.json`)
- Recharts 3.8.1 (`frontend/package.json`)
- Zustand 5.0.13 (`frontend/package.json`)
- MQTT.js 5.15.1 (`frontend/package.json`)
- Tailwind CSS 3.4.17 (`frontend/package.json`)
- QR Code React 4.2.0 (`frontend/package.json`)

### Cloud Functions Backend
- Node.js 20 runtime (`backend/functions/package.json`)
- Firebase Functions v2 5.0.0 (`backend/functions/package.json`)
- Firebase Admin SDK 12.0.0 (`backend/functions/package.json`)
- Zod 3.22.4 (`backend/functions/package.json`)
- pdf-lib 1.17.1 (`backend/functions/package.json`)
- MQTT 5.15.1 (`backend/functions/package.json`)

### Machine Learning Microservice
- Python 3.11 (`refillx-ai/Dockerfile`)
- Flask 3.0.0 (`refillx-ai/requirements.txt`)
- Gunicorn 21.2.0 (`refillx-ai/requirements.txt`)
- scikit-learn 1.4.0 (`refillx-ai/requirements.txt`)
- statsmodels 0.14.1 (`refillx-ai/requirements.txt`)
- TensorFlow 2.15.0 (`refillx-ai/requirements.txt`)
- pandas 2.1.4 (`refillx-ai/requirements.txt`)
- numpy 1.26.3 (`refillx-ai/requirements.txt`)
- implicit 0.7.2 (`refillx-ai/requirements.txt`)
- google-cloud-firestore 2.14.0 (`refillx-ai/requirements.txt`)
- pydantic 2.5.3 (`refillx-ai/requirements.txt`)
- pytest 8.0.0 (`refillx-ai/requirements.txt`)

### Embedded Firmware and Hardware Simulator
- Arduino framework for ESP32 (`firmware/refillx-esp32/main.cpp`)
- PubSubClient MQTT client (`firmware/refillx-esp32/main.cpp`)
- ArduinoJson (`firmware/refillx-esp32/main.cpp`)
- mbedtls SHA256 engine (`firmware/refillx-esp32/main.cpp`)
- paho-mqtt (`virtual_esp32.py`)

## Architecture Overview
The system is divided into four operational tiers:

```mermaid
graph TD
    subgraph Client Tier
        PWA["React 18 PWA (Vite, IndexedDB)"]
        Kiosk["Standalone Kiosks (HTML/JS)"]
    end

    subgraph IoT & Edge Tier
        ESP32["ESP32 Dispenser Firmware (main.cpp)"]
        Sim["Virtual Dispenser (virtual_esp32.py)"]
        MQTT["EMQX MQTT Broker (broker.emqx.io)"]
    end

    subgraph Cloud Backend Tier
        CF["Firebase Cloud Functions v2 (Node.js)"]
        PyServer["Python Server (server.py)"]
        Firestore[("Cloud Firestore")]
        Storage[("Cloud Storage (PDFs)")]
        FCM["Firebase Cloud Messaging"]
    end

    subgraph Analytics & ML Tier
        MLService["Flask AI Service (refillx-ai)"]
        ARIMA["ARIMA / LSTM Forecasters"]
        Recommender["Collaborative Filter"]
        Cluster["K-Means Segmenter"]
    end

    PWA -->|HTTPS / Callable| CF
    PWA -->|IndexedDB Cache| PWA
    PWA -->|MQTT / WSS| MQTT
    CF -->|Read / Write| Firestore
    CF -->|Store Receipts| Storage
    CF -->|Push Alerts| FCM
    CF -->|Publish Command| MQTT

    ESP32 -->|TLS Port 8883| MQTT
    Sim -->|TCP Port 1883| MQTT
    MQTT -->|Pub/Sub Event| CF

    CF -->|Scheduled Sync| MLService
    MLService -->|Load Transactions| Firestore
    MLService --> ARIMA
    MLService --> Recommender
    MLService --> Cluster

    Kiosk -->|HTTP API| PyServer
    PyServer -->|REST Sync| Firestore
