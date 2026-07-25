






let currentStream = null;
let scanLoopRunning = false;
let scanAnimationId = null;
let videoFeed = null;
let lastTime = 0;

let frameCount = 0;
let fps = 0;
let lastFpsUpdate = 0;

function safeAddListener(id, event, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn('Missing element with id:', id);
  }
}

    const CLOUD_URL = window.location.origin;
    window.db = "LocalCloud";
    window.fbRef = (db, path) => path;
    function getPending() { return JSON.parse(localStorage.getItem("rxPendingWrites") || "[]"); }
    function savePending(writes) { localStorage.setItem("rxPendingWrites", JSON.stringify(writes)); }
    
    window.safeSet = async function(path, data) {
      try {
        if(!MACHINE.isOnline) throw new Error("Offline");
        await fetch(CLOUD_URL + "/api/set", { method:"POST", body: JSON.stringify({path, data}) });
      } catch(e) {
        const p = getPending(); p.push({ action: "set", path, data }); savePending(p);
      }
    }
    window.safeUpdate = async function(path, data) {
      try {
        if(!MACHINE.isOnline) throw new Error("Offline");
        await fetch(CLOUD_URL + "/api/update", { method:"POST", body: JSON.stringify({path, data}) });
      } catch(e) {
        const p = getPending(); p.push({ action: "update", path, data }); savePending(p);
      }
    }
    
    window.fbGet = async function(path) {
       const res = await fetch(CLOUD_URL + "/api/get?path=" + encodeURIComponent(path));
       const data = await res.json();
       return { exists: () => data.value !== null, val: () => data.value };
    }
    window.get = window.fbGet;
    window.ref = window.fbRef;
    
    let GLOBAL_STATE = {};
    const listeners = [];
    window.fbOnValue = function(path, callback) {
      listeners.push({ path, callback });
    }
    window.onValue = window.fbOnValue;
    window.fbSet = window.safeSet;
    
    function getByPath(d, p) {
      const keys = p.split("/").filter(k=>k);
      let curr = d;
      for(let k of keys) { if(curr && curr[k] !== undefined) curr = curr[k]; else return null; }
      return curr;
    }
    
    setInterval(async () => {
      try {
        const res = await fetch(CLOUD_URL + "/api/sync");
        if(!res.ok) throw new Error("Server error");
        const data = await res.json();
        
        if(!MACHINE.isOnline) {
          MACHINE.isOnline = true;
          const pending = getPending();
          if(pending.length > 0) {
             for(let task of pending) {
               try { await fetch(CLOUD_URL + "/api/" + task.action, { method:"POST", body: JSON.stringify({path:task.path, data:task.data}) }); } catch(e){}
             }
             savePending([]);
          }
        }
        
        GLOBAL_STATE = data;
        listeners.forEach(l => {
           const val = getByPath(data, l.path);
           if(val !== null) l.callback({ val: () => val, exists: () => val !== null });
        });
        
        document.getElementById("online-badge").innerText = "ONLINE";
        document.getElementById("online-badge").style.background = "var(--green-accent)";
        document.getElementById("offline-banner").style.display = "none";
      } catch(e) {
        MACHINE.isOnline = false;
        document.getElementById("online-badge").innerText = "OFFLINE";
        document.getElementById("online-badge").style.background = "var(--amber)";
        document.getElementById("offline-banner").style.display = "block";
      }
    }, 1500);

    const MACHINE = {
      screen: 1, product: null, quantity: null, pricePer100ml: 0, sessionId: null, dispensedMl: 0,
      tankLevels: JSON.parse(localStorage.getItem('rxTanks')) || { water: 75, shampoo: 45, detergent: 22, handwash: 60, oil: 40 },
      isOnline: true, isDispensing: false, authData: null
    };
    
    const PRODUCTS = {
      water: { name: "RO Water", icon: "💧", price: 0.20, color: "#0ea5e9" }, // 20rs per litre
      shampoo: { name: "Shampoo", icon: "🧴", price: 80.00, color: "#4a2b66" }, // 800rs per litre
      detergent: { name: "Liquid Detergent", icon: "🫧", price: 20.00, color: "#7d4411" }, // 200rs per litre
      handwash: { name: "Handwash", icon: "🤲", price: 30.00, color: "#175452" }, // 300rs per litre
      oil: { name: "Cooking Oil", icon: "🫒", price: 15.00, color: "#9c7625" } // 150rs per litre
    };

    const actx = new (window.AudioContext || window.webkitAudioContext)();
    let humOsc = null;
    function playTone(freq, type, duration, vol=0.1) {
      if(actx.state === 'suspended') actx.resume();
      const osc = actx.createOscillator(); const gain = actx.createGain();
      osc.type = type; osc.frequency.value = freq; osc.connect(gain); gain.connect(actx.destination);
      gain.gain.setValueAtTime(vol, actx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + duration);
      osc.start(); osc.stop(actx.currentTime + duration);
    }
    function playTap() { playTone(600, 'sine', 0.1, 0.05); }
    function playSuccess() { playTone(500, 'sine', 0.1); setTimeout(()=>playTone(800, 'sine', 0.2), 100); }
    function playError() { playTone(150, 'sawtooth', 0.3, 0.2); }
    function startHum() {
      if(actx.state === 'suspended') actx.resume();
      humOsc = actx.createOscillator(); const gain = actx.createGain();
      humOsc.type = 'triangle'; humOsc.frequency.value = 60; humOsc.connect(gain); gain.connect(actx.destination);
      gain.gain.value = 0.05; humOsc.start();
    }
    function stopHum() { if(humOsc) { humOsc.stop(); humOsc = null; } }
    
    document.addEventListener('click', (e) => { if(e.target.tagName === 'BUTTON' || e.target.closest('.btn')) playTap(); });

    let idleTimer;
    function resetIdleTimer() {
      clearTimeout(idleTimer);
      if(MACHINE.screen > 1 && MACHINE.screen < 7) {
        idleTimer = setTimeout(() => { showToast("Session expired due to inactivity"); resetToIdle(); }, 120000);
      }
    }
    document.addEventListener('touchstart', resetIdleTimer); document.addEventListener('click', resetIdleTimer);

    
    // ----------------------------------------------------
    // ROBUST START BUTTON PIPELINE (BASED ON CHECKLIST)
    // ----------------------------------------------------
    window.onerror = (msg, src, line, col, err) => {
      console.error(`JS Error at ${src}:${line} - ${msg}`);
      const t = document.getElementById('toast');
      if(t) { t.innerText = `Error: ${msg}`; t.style.display = 'block'; setTimeout(()=>t.style.display='none', 5000); }
    };

    async function handleStart(e) {
      if(e) e.preventDefault(); // prevent ghost clicks
      const startBtn = document.getElementById('start-btn');
      if (startBtn) {
        startBtn.style.transform = 'scale(0.95)';
        setTimeout(() => startBtn.style.transform = 'scale(1)', 150);
      }
      
      console.log('Start button clicked');
      
      try {
        console.log('Starting kiosk flow...');
        // Transition to camera/QR scan screen
        window.showScreen(5, 'Scan QR', 1);
      } catch (err) {
        console.error('Start failed:', err);
        showToast(`Start failed: ${err.message}`);
      }
    }

    window.addEventListener('load', () => {
      const startBtn = document.getElementById('start-btn');
      if (!startBtn) {
        console.error('Start button element not found in DOM');
        return;
      }
      
      // Ensure button is not disabled
      startBtn.removeAttribute('disabled');
      startBtn.classList.remove('disabled', 'btn-disabled', 'inactive');
      startBtn.style.pointerEvents = 'auto';
      startBtn.style.opacity = '1';
      startBtn.style.cursor = 'pointer';

      // Event listeners
      safeAddListener('start-btn', 'click', handleStart);
      safeAddListener('start-btn', 'touchend', handleStart);
    });

    function showScreen(num, stepName, stepNum) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(`screen-${num}`).classList.add('active');
      MACHINE.screen = num;
      document.getElementById('step-text').innerText = stepName ? `Step ${stepNum} of 5: ${stepName}` : "RefillX System";
      
      if(num == 4) initScreen4();
      if(num == 5) startCamera();
      if(num == 6) initScreen6();
      if(num == 7) initScreen7();
      if(num == 8) initScreen8();
      if(num == 9) initScreen9();
      resetIdleTimer();
    }

    function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast-message');
  if (!toast) {
    console.warn('Toast element missing:', message);
    return;
  }
  toast.innerText = message;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, duration);
}

    function resetToIdle() {
      MACHINE.product = null; MACHINE.quantity = null; MACHINE.dispensedMl = 0; MACHINE.authData = null;
      stopHum(); stopCam();
      if(window.dispenseInterval) clearInterval(window.dispenseInterval);
      showScreen(1, "Welcome", 0);
    }

    let statIdx = 1;
    setInterval(() => {
      if(MACHINE.screen !== 1) return;
      document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
      statIdx = statIdx >= 3 ? 1 : statIdx + 1;
      document.getElementById(`stat-${statIdx}`).classList.add('active');
    }, 3000);

    // --- Screen 4: Place Bottle ---
    // --- Screen 4: Place Bottle (Real GPS Distance) ---
    let gpsInterval;
    let fallbackPollInterval;
    let consecutiveClose = 0;
    
    function haversine(lat1, lng1, lat2, lng2) {
      if(!lat1 || !lng1 || !lat2 || !lng2) return 999;
      const R = 6371; // km
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2) * Math.sin(dLng/2);
      return Math.max(0, R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1000); // metres
    }

    function initScreen4() {
      // Reset State
      MACHINE.kioskLat = null; MACHINE.kioskLng = null; consecutiveClose = 0; MACHINE.proximityCode = null;
      document.getElementById('gps-ui-container').style.display = 'block';
      document.getElementById('fallback-ui-container').style.display = 'none';
      document.getElementById('btn-bottle-next').disabled = true;
      document.getElementById('btn-bottle-next').classList.add('opacity-50');
      document.getElementById('s4-title').innerText = "Detecting your bottle";
      
      // Reset UI elements
      document.getElementById('dist-text').innerText = '--';
      document.getElementById('dist-circle-fill').style.strokeDashoffset = 879;
      document.getElementById('prox-fill').style.width = '0%';
      document.getElementById('prox-dot').style.left = '100%';
      document.getElementById('dist-status').innerText = 'Waiting for phone location...';
      document.getElementById('dist-status').className = 'text-xl font-bold text-gray-400 mt-4 h-8';
      document.querySelectorAll('.radar-ring').forEach(r => r.style.display = 'block');
      
      // Get Kiosk Location
      document.getElementById('kiosk-gps-status').innerText = "📍 Acquiring Kiosk GPS...";
      if(navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            MACHINE.kioskLat = pos.coords.latitude; MACHINE.kioskLng = pos.coords.longitude;
            document.getElementById('kiosk-gps-status').innerText = "📍 Station location acquired";
            document.getElementById('dbg-k-loc').innerText = `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
          },
          (err) => {
            document.getElementById('kiosk-gps-status').innerText = "📍 GPS unavailable — using fallback mode";
            startFallbackMode();
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      }
      
      // Sync loop
      gpsInterval = setInterval(syncPhoneLocation, 2000);
    }
    
    function syncPhoneLocation() {
      if(MACHINE.screen !== 4) return clearInterval(gpsInterval);
      if(MACHINE.proximityCode) return; // In fallback mode
      
      // Force Demo Mode?
      const forceDemo = document.getElementById('chk-force-gps').checked;
      if(forceDemo) {
        MACHINE.kioskLat = 13.0827; MACHINE.kioskLng = 80.2707;
        document.getElementById('kiosk-gps-status').innerText = "📍 Station location forced (Demo)";
        document.getElementById('dbg-k-loc').innerText = "13.0827, 80.2707";
      }
      
      // Read phone location from Firebase (if sessionId exists? No, we don't have sessionId yet)
      // Wait, on Screen 4, we don't have the QR code yet! The Mobile App hasn't generated the QR yet!
      // Actually, the user's flow says: "Mobile generates QR -> User scans QR -> Kiosk dispenses".
      // But the Place Bottle screen is BEFORE QR scan (Screen 5).
      // Ah! The user requested: "The mobile phone acts as the bottle... On the Waiting Screen (after QR is generated and shown): immediately start watchPosition... write to localStorage... Kiosk reads phone coordinates".
      // BUT they are on different laptops! The Kiosk doesn't know the Mobile App's session ID until they SCAN the QR!
      // This is a flaw. Since we cannot share localStorage, and we don't have the session ID, we can use a global 'demo_location' node in Firebase!
      
      if(window.db && window.fbRef && window.fbOnValue && !window._fbListeningDemo) {
        window._fbListeningDemo = true;
        window.fbOnValue(window.fbRef(window.db, 'global_demo/phoneLocation'), (snap) => {
          window.latestPhoneLoc = snap.val();
        });
        window.fbOnValue(window.fbRef(window.db, 'global_demo/proximityConfirmed'), (snap) => {
          if(snap.val() === true && MACHINE.screen === 4 && MACHINE.proximityCode) {
            triggerBottleConfirmed();
            if(window.fbSet) window.fbSet(window.fbRef(window.db, 'global_demo/proximityConfirmed'), false);
          }
        });
      }
      
      const phoneLoc = window.latestPhoneLoc;
      if(!phoneLoc || Date.now() - phoneLoc.ts > 15000) return; // Stale or empty
      
      let pLat = phoneLoc.lat; let pLng = phoneLoc.lng; let pAcc = phoneLoc.accuracy;
      if(forceDemo) { pLat = 13.08271; pLng = 80.27072; pAcc = 5; } // Fake close coordinates
      
      document.getElementById('dbg-p-loc').innerText = `${pLat.toFixed(4)}, ${pLng.toFixed(4)}`;
      document.getElementById('dbg-time').innerText = new Date(phoneLoc.ts).toLocaleTimeString();
      document.getElementById('gps-acc').innerText = `±${Math.round(pAcc)}m`;
      
      // Fallback check
      if(pAcc > 15 && !forceDemo) return startFallbackMode();
      
      // Calc distance
      let dist = haversine(MACHINE.kioskLat, MACHINE.kioskLng, pLat, pLng);
      if(forceDemo) dist = Math.random() * 2; // Simulate moving around 0-2m
      
      document.getElementById('dbg-dist').innerText = dist.toFixed(2) + "m";
      document.getElementById('dist-text').innerText = dist.toFixed(1);
      document.getElementById('hc-dist').innerText = Math.round(dist * 100) + " cm";
      
      // Update UI
      // Circle: 879 is empty, 0 is full (5m scale)
      let pct = Math.max(0, Math.min(100, ((5 - dist) / 5) * 100));
      document.getElementById('dist-circle-fill').style.strokeDashoffset = 879 - (879 * pct / 100);
      document.getElementById('prox-fill').style.width = pct + "%";
      document.getElementById('prox-dot').style.left = pct + "%";
      
      // Floor plan
      document.getElementById('fp-phone-icon').style.transform = `translateX(${Math.min(150, dist * 30)}px)`;
      
      const statusEl = document.getElementById('dist-status');
      if(dist > 3) {
        statusEl.innerText = "🔴 Too far — bring your bottle closer";
        statusEl.style.color = "#ff4b4b";
        consecutiveClose = 0;
      } else if (dist > 1.5) {
        statusEl.innerText = "🟡 Getting closer — almost there...";
        statusEl.style.color = "#f0b429";
        consecutiveClose = 0;
      } else {
        statusEl.innerText = "🟢 Bottle detected! ✓ Hold still...";
        statusEl.style.color = "#3ecf7a";
        consecutiveClose++;
      }
      document.getElementById('dbg-cons').innerText = consecutiveClose + "/3";
      
      if(consecutiveClose >= 3) triggerBottleConfirmed();
    }
    
    function startFallbackMode() {
      if(MACHINE.proximityCode) return;
      MACHINE.proximityCode = Math.floor(1000 + Math.random() * 9000).toString();
      
      document.getElementById('gps-ui-container').style.display = 'none';
      document.getElementById('fallback-ui-container').style.display = 'flex';
      document.getElementById('s4-title').innerText = "Confirm Proximity";
      
      const boxes = document.querySelectorAll('.otp-box');
      for(let i=0; i<4; i++) boxes[i].innerText = MACHINE.proximityCode[i];
      
      if(window.db && window.fbRef && window.fbSet) {
        window.fbSet(window.fbRef(window.db, 'global_demo/proximityCode'), MACHINE.proximityCode);
      }
    }
    
    function triggerBottleConfirmed() {
      clearInterval(gpsInterval);
      playSuccess();
      document.getElementById('dist-status').innerText = "🟢 Bottle Confirmed! Proceeding...";
      document.getElementById('s4-title').innerText = "Ready for Refill!";
      document.querySelectorAll('.radar-ring').forEach(r => r.style.display = 'none');
      document.getElementById('btn-bottle-next').disabled = false;
      document.getElementById('btn-bottle-next').classList.remove('opacity-50');
      
      // Auto advance after 1.5s
      setTimeout(() => {
        if(MACHINE.screen === 4) showScreen(5, 'Scan QR', 2);
      }, 1500);
    }
    
    function handleDemoOverride() {
      console.log("Session Log: Bottle detected via ManualOverride");
      triggerBottleConfirmed();
    }
    
    // Hold 3 seconds for Manual Override
    let overrideTimer;
    let overrideStart;
    const overrideBtn = document.getElementById('btn-demo-override');
    const overrideProg = document.getElementById('override-progress');
    
    function startOverride(e) {
      if(e.type === 'touchstart') e.preventDefault(); // prevent mouse emulation
      overrideStart = Date.now();
      overrideProg.style.transition = 'width 3s linear';
      overrideProg.style.width = '100%';
      overrideTimer = setTimeout(() => {
        handleDemoOverride();
      }, 3000);
    }
    function stopOverride() {
      clearTimeout(overrideTimer);
      overrideProg.style.transition = 'width 0.2s ease-out';
      overrideProg.style.width = '0%';
    }
    
    if (overrideBtn) {
      overrideBtn.addEventListener('mousedown', startOverride);
      overrideBtn.addEventListener('touchstart', startOverride);
      overrideBtn.addEventListener('mouseup', stopOverride);
      overrideBtn.addEventListener('mouseleave', stopOverride);
      overrideBtn.addEventListener('touchend', stopOverride);
    }

    // --- Screen 5: QR Scan ---
    
    const videoOverlay = document.getElementById('overlay');
    const ctxOverlay = videoOverlay.getContext('2d');
    
    // ----------------------------------------------------
    // ROBUST CAMERA PIPELINE (BASED ON CHECKLIST)
    const hiddenCanvas = document.createElement('canvas');
    const ctxHidden = hiddenCanvas.getContext('2d', { willReadFrequently: true });
    
        // ----------------------------------------------------
    
    
     
    
    
    

    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && !location.hostname.endsWith('loca.lt') && !location.hostname.endsWith('.ngrok-free.app') && !location.hostname.endsWith('.ngrok.io') && !location.hostname.endsWith('.trycloudflare.com')) {
        setTimeout(() => showToast('Camera requires HTTPS. Please use the secure URL.'), 1000);
    }

    
    async function startCamera() {
      try {
        if (currentStream) {
          currentStream.getTracks().forEach(t => t.stop());
          currentStream = null;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, min: 10 }
          },
          audio: false
        });

        currentStream = stream;

        const video = document.getElementById('webcam');
        videoFeed = video;
        if (!video) {
          console.error('webcam element not found in HTML');
          return;
        }

        video.srcObject = stream;
        video.style.display = 'block';
        video.style.visibility = 'visible';
        video.style.opacity = '1';
        video.style.zIndex = '1';
        video.style.position = 'absolute';
        video.style.top = '0';
        video.style.left = '0';
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'cover';

        video.onloadedmetadata = () => {
          video.play().then(() => {
            console.log('✅ Camera live:', video.videoWidth + 'x' + video.videoHeight);
            const hiddenCanvas = document.createElement('canvas');
            const ctxHidden = hiddenCanvas.getContext('2d', { willReadFrequently: true });
            
            const canvas = document.getElementById('overlay');
            if (canvas) {
              canvas.width = video.videoWidth || 1280;
              canvas.height = video.videoHeight || 720;
            }
            startQRScanLoop();
          }).catch(err => {
            console.error('Video play() failed:', err);
            showToast('Camera play failed: ' + err.message);
          });
        };

      } catch (err) {
        console.error('Camera error:', err.name, err.message);
        showToast('Camera error: ' + err.name);
      }
    }

    async function retryCamera() {
      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
      }
      if(videoFeed) videoFeed.srcObject = null;
      scanLoopRunning = false;
      await startCamera(); 
    }

    function stopCam() { 
      scanLoopRunning = false; 
      if (currentStream) {
          currentStream.getTracks().forEach(t => t.stop());
          currentStream = null;
      }
      if(videoFeed) videoFeed.srcObject = null;
    }

    function startQRScanLoop() {
      if (scanLoopRunning) return;
      scanLoopRunning = true;
      requestAnimationFrame(scanFrame);
    }

    function updateFPS() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsUpdate >= 1000) {
    fps = Math.round(frameCount * 1000 / (now - lastFpsUpdate));
    frameCount = 0;
    lastFpsUpdate = now;
    const fpsEl = document.getElementById('cam-fps') 
                  || document.querySelector('[id*="fps"]')
                  || document.querySelector('[class*="fps"]');
    if (fpsEl) fpsEl.textContent = fps + ' FPS';
  }
}

function scanFrame(timestamp) {
  if (!scanLoopRunning) return;
  if (!videoFeed) {
    scanAnimationId = requestAnimationFrame(scanFrame);
    return;
  }

  if (timestamp - lastTime < 66) {
    scanAnimationId = requestAnimationFrame(scanFrame);
    return;
  }
  lastTime = timestamp;

  if (videoFeed.readyState === videoFeed.HAVE_ENOUGH_DATA) {
    const canvas = document.getElementById('overlay');
    if (!canvas) {
      scanAnimationId = requestAnimationFrame(scanFrame);
      return;
    }

    if (canvas.width !== videoFeed.videoWidth) {
      canvas.width = videoFeed.videoWidth;
      canvas.height = videoFeed.videoHeight;
    }

    const ctx = canvas.getContext('2d');
    
    const hiddenCanvas = document.createElement('canvas');
    hiddenCanvas.width = canvas.width;
    hiddenCanvas.height = canvas.height;
    const ctxHidden = hiddenCanvas.getContext('2d', { willReadFrequently: true });
    
    ctxHidden.drawImage(videoFeed, 0, 0, canvas.width, canvas.height);

    const imageData = ctxHidden.getImageData(
      0, 0, canvas.width, canvas.height
    );

    if (typeof jsQR !== 'undefined') {
      const code = jsQR(
        imageData.data,
        imageData.width,
        imageData.height,
        { inversionAttempts: 'attemptBoth' }
      );
      if (code && code.data) {
        console.log('✅ QR detected:', code.data);
        scanLoopRunning = false;
        
        ctx.clearRect(0,0, canvas.width, canvas.height);
        ctx.lineWidth = 4; ctx.strokeStyle = "#00FF00";
        ctx.beginPath();
        ctx.moveTo(code.location.topLeftCorner.x, code.location.topLeftCorner.y);
        ctx.lineTo(code.location.topRightCorner.x, code.location.topRightCorner.y);
        ctx.lineTo(code.location.bottomRightCorner.x, code.location.bottomRightCorner.y);
        ctx.lineTo(code.location.bottomLeftCorner.x, code.location.bottomLeftCorner.y);
        ctx.closePath(); ctx.stroke();
        document.querySelectorAll('.scan-bracket').forEach(b => b.style.borderColor = '#00FF00');
        playSuccess();
        processQR(code.data);
        return;
      }
    } else {
      console.error('jsQR library not loaded');
    }

    updateFPS();
  }

  scanAnimationId = requestAnimationFrame(scanFrame);
}

    function processQR(dataStr) {
      try {
        if(!MACHINE.isOnline) throw new Error("Offline mode. Use local cache.");
        const payload = JSON.parse(dataStr);
        if (payload.exp && payload.exp < Date.now()) throw new Error("QR expired — please regenerate in app");
        if (!PRODUCTS[payload.prod]) throw new Error("Invalid product requested");
        
        // Low tank logic integration
        const reqQty = parseInt(payload.qty);
        const tankPct = MACHINE.tankLevels[payload.prod];
        const tankMaxMl = 5000; // Assume 5L tank
        const availMl = (tankPct / 100) * tankMaxMl;
        
        MACHINE.product = payload.prod;
        MACHINE.pricePer100ml = PRODUCTS[payload.prod].price;
        MACHINE.amount = payload.amt || ((MACHINE.quantity/100) * MACHINE.pricePer100ml);
        MACHINE.sessionId = payload.sid;
        MACHINE.authData = payload; // includes name, email

        if(reqQty > availMl) {
          if(availMl < 50) throw new Error("Tank is completely empty.");
          MACHINE.quantity = availMl; // Auto reduce
          showToast(`Only ${availMl.toFixed(0)}ml left in machine. Filling that much.`);
        } else {
          MACHINE.quantity = reqQty;
        }

        playSuccess();
        document.getElementById('qr-error').innerText = "QR Verified ✓";
        document.getElementById('qr-error').style.color = "var(--green-bright)";
        document.querySelectorAll('.scan-bracket').forEach(b => b.classList.add('pulse-glow'));
        setTimeout(() => { stopCam(); showScreen(6, 'Authentication', 3); }, 1000);
      } catch(e) {
        playError(); document.getElementById('qr-error').innerText = e.message || "Invalid QR Code format"; document.getElementById('qr-error').style.color = "var(--red)"; document.getElementById('video-box').classList.add('shake');
        setTimeout(() => document.getElementById('video-box').classList.remove('shake'), 400); setTimeout(() => requestAnimationFrame(scanLoop), 1500);
      }
    }
    function demoQR() { processQR(JSON.stringify({ sid: "RFX-"+Date.now().toString(36).toUpperCase(), name: "Divyansh Singh", email: "divyansh@example.com", prod: "water", qty: 2000, amt: 40.00, exp: Date.now()+100000 })); }

    // --- Screen 6: Auth ---
    function initScreen6() {
      document.getElementById('auth-success').classList.add('hidden');
      for(let i=1; i<=5; i++) document.getElementById(`chk-${i}`).className = 'checklist-item';
      
      const delays = [600, 800, 700, 600, 500]; let cumulative = 0;
      for(let i=1; i<=5; i++) {
        cumulative += delays[i-1];
        setTimeout(() => {
          document.getElementById(`chk-${i}`).className = 'checklist-item done'; playTap();
          if(i===5) {
            setTimeout(() => {
              document.getElementById('auth-success').classList.remove('hidden');
              document.getElementById('auth-name').innerText = MACHINE.authData.name;
              document.getElementById('auth-email').innerText = MACHINE.authData.email;
              document.getElementById('auth-initials').innerText = MACHINE.authData.name.substring(0,2).toUpperCase();
              document.getElementById('auth-order-desc').innerText = `${MACHINE.quantity.toFixed(0)}ml ${PRODUCTS[MACHINE.product].name}`;
              document.getElementById('auth-order-price').innerText = `₹${((MACHINE.quantity/100)*MACHINE.pricePer100ml).toFixed(2)}`;
              playSuccess();
            }, 500);
          }
        }, cumulative);
      }
    }
    function simulateAuthFail() { showToast("Authentication failed: Invalid QR signature"); setTimeout(resetToIdle, 3000); }

    // --- Screen 7: Dispense ---
    let sparkData = Array(20).fill(0);
    function startDispense() { showScreen(7, 'Dispensing', 4); }
    function initScreen7() {
      MACHINE.isDispensing = true; MACHINE.dispensedMl = 0; sparkData = Array(20).fill(0);
      document.getElementById('m-solenoid').innerText = "OPEN"; document.getElementById('m-solenoid').className = "solenoid open";
      document.getElementById('m-stream').style.height = "250px";
      document.getElementById('disp-target').innerText = `/ ${MACHINE.quantity.toFixed(0)} ml`;
      
      const pColor = PRODUCTS[MACHINE.product].color;
      document.getElementById('m-tank-liquid').style.background = pColor; document.getElementById('m-bottle-liquid').style.background = pColor; document.getElementById('m-stream').style.background = pColor;
      document.getElementById('m-tank-liquid').style.height = MACHINE.tankLevels[MACHINE.product] + "%"; document.getElementById('m-bottle-liquid').style.height = "0%";
      startHum();
      
      const drops = [];
      for(let i=0; i<5; i++) { const d = document.createElement('div'); d.className='droplet'; d.style.background=pColor; d.style.animation = `dropFall 0.4s infinite linear ${i*0.1}s`; document.querySelector('.machine-visual').appendChild(d); drops.push(d); }
      
      window.dispenseInterval = setInterval(() => {
        let flow = 0.6 + (Math.random()*0.1 - 0.05); // Reduced flow to ~0.6 L/m for realistic speed
        let mlPerTick = (flow * 1000) / 300; // ~2ml per 200ms tick = ~10ml/sec
        MACHINE.dispensedMl += mlPerTick;
        if (MACHINE.dispensedMl >= MACHINE.quantity) { MACHINE.dispensedMl = MACHINE.quantity; finishDispense(drops); }
        
        document.getElementById('disp-ml').innerText = Math.floor(MACHINE.dispensedMl);
        let pct = MACHINE.dispensedMl / MACHINE.quantity;
        document.getElementById('disp-gauge').style.strokeDashoffset = 628 - (628 * pct);
        document.getElementById('m-bottle-liquid').style.height = (pct * 90) + "%";
        if (window.db && window.fbRef && window.fbSet && MACHINE.sessionId) {
          let currentPct = Math.floor(pct * 100);
          if (window.lastFbPct !== currentPct && currentPct % 5 === 0) { // Only update every 5% to prevent lag
            window.lastFbPct = currentPct;
            window.fbSet(window.fbRef(window.db, 'sessions/' + MACHINE.sessionId), { status: 'dispensing', progress: currentPct, ts: Date.now() });
          }
        }
        
        MACHINE.tankLevels[MACHINE.product] -= (mlPerTick / 5000) * 100;
        document.getElementById('m-tank-liquid').style.height = MACHINE.tankLevels[MACHINE.product] + "%";
        
        document.getElementById('disp-flow').innerHTML = `${flow.toFixed(1)} <span class="text-lg text-white">L/m</span>`;
        document.getElementById('disp-temp').innerHTML = `${(24.2 + Math.random()*0.4).toFixed(1)} <span class="text-lg text-white">°C</span>`;
        document.getElementById('disp-tds').innerHTML = `${Math.floor(142 + Math.random()*5)} <span class="text-lg text-white">ppm</span>`;
        
        let timeLeft = ((MACHINE.quantity - MACHINE.dispensedMl) / (flow*1000/60)).toFixed(0);
        document.getElementById('disp-time').innerHTML = `0:${timeLeft.padStart(2,'0')} <span class="text-lg text-white">s</span>`;
        
        sparkData.shift(); sparkData.push(flow);
        let pts = sparkData.map((v, i) => `${i*5},${60 - (v*20)}`).join(' ');
        document.getElementById('disp-spark').setAttribute('points', pts);
      }, 200);
    }
    
    function emergencyStop() { if(!MACHINE.isDispensing) return; showToast("EMERGENCY STOP. Valve closed."); playError(); finishDispense([], true); }
    
    function finishDispense(drops=[], isEstop=false) {
      clearInterval(window.dispenseInterval); MACHINE.isDispensing = false; stopHum();
      document.getElementById('m-solenoid').innerText = "CLOSED"; document.getElementById('m-solenoid').className = "solenoid";
      document.getElementById('m-stream').style.height = "0"; drops.forEach(d => d.remove());
      
      // Tell mobile app that dispensing is done so it can show payment UI
      if (window.db && window.fbRef && window.fbSet && MACHINE.sessionId) {
        window.fbSet(window.fbRef(window.db, 'sessions/' + MACHINE.sessionId), { status: 'complete', ts: Date.now() });
      }
      
      localStorage.setItem('rxTanks', JSON.stringify(MACHINE.tankLevels));
      if(!isEstop) { playSuccess(); setTimeout(() => showScreen(8, 'Payment', 5), 1500); } else { setTimeout(resetToIdle, 3000); }
    }

    // --- Screen 8: Payment ---
    function initScreen8() {
      document.getElementById('success-anim').style.display = 'block'; document.getElementById('payment-box').style.display = 'none';
      document.getElementById('pay-summary-text').innerText = `${Math.floor(MACHINE.dispensedMl)}ml ${PRODUCTS[MACHINE.product].name} refilled successfully`;
      setTimeout(() => {
        document.getElementById('success-anim').style.display = 'none'; document.getElementById('payment-box').style.display = 'block';
        const amt = ((MACHINE.dispensedMl/100) * MACHINE.pricePer100ml).toFixed(2);
        document.getElementById('pay-amt').innerText = `₹${amt}`;
        
        let t = 300;
        const timerInt = setInterval(() => {
          if(MACHINE.screen !== 8) clearInterval(timerInt); t--;
          document.getElementById('pay-timer').innerText = `${Math.floor(t/60)}:${(t%60).toString().padStart(2,'0')}`;
          if(t<=0) resetToIdle();
        }, 1000);
      }, 3000);
    }
    
    function completePayment() {
      // Mark session as complete so mobile app shows success screen
      if (window.db && window.fbRef && window.fbSet && MACHINE.sessionId) {
        window.fbSet(window.fbRef(window.db, 'sessions/' + MACHINE.sessionId), { status: 'complete', ts: Date.now() });
      }
      playSuccess(); showScreen(9, "Receipt", 5); 
    }

    // --- Screen 9: Receipt ---
    function initScreen9() {
      const d = new Date();
      document.getElementById('r-date').innerText = d.toLocaleDateString(); document.getElementById('r-time').innerText = d.toLocaleTimeString();
      document.getElementById('r-txn').innerText = MACHINE.sessionId || "TXN-DEMO123";
      document.getElementById('r-user').innerText = MACHINE.authData.name;
      document.getElementById('r-prod').innerText = `${PRODUCTS[MACHINE.product].name} (${Math.floor(MACHINE.dispensedMl)}ml)`;
      const amt = ((MACHINE.dispensedMl/100) * MACHINE.pricePer100ml).toFixed(2);
      document.getElementById('r-amt').innerText = `₹${amt}`; document.getElementById('r-unit').innerText = `₹${MACHINE.pricePer100ml.toFixed(2)} / 100ml`;
      document.getElementById('r-pts').innerText = '+' + Math.floor(MACHINE.dispensedMl/10); document.getElementById('r-co2').innerText = Math.floor(MACHINE.dispensedMl * 0.024) + 'g';
      document.getElementById('r-qr').innerHTML = ""; new QRCode(document.getElementById('r-qr'), { text: MACHINE.sessionId, width: 128, height: 128 });
    }
    async function emailReceipt() {
      const btn = document.querySelector('.btn-outline:nth-child(2)');
      btn.innerText = "Sending..."; btn.disabled = true;
      
      const payload = {
        email: MACHINE.authData.email,
        name: MACHINE.authData.name,
        product: PRODUCTS[MACHINE.product].name,
        volume: `${Math.floor(MACHINE.dispensedMl)}ml`,
        price: `₹${((MACHINE.dispensedMl/100) * MACHINE.pricePer100ml).toFixed(2)}`,
        date_time: `${document.getElementById('r-date').innerText} ${document.getElementById('r-time').innerText}`,
        txn: MACHINE.sessionId
      };
      
      try {
        const res = await fetch(CLOUD_URL + '/api/call/sendReceipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: payload })
        });
        const data = await res.json();
        
        if(data.success) {
          showToast(`Receipt successfully sent to ${MACHINE.authData.email}!`);
          btn.innerText = "Sent ✓";
        } else {
          showToast(`Failed to send: ${data.error}`);
          btn.innerText = "Email Failed";
        }
      } catch(err) {
        showToast("Error connecting to email server.");
        btn.innerText = "Email Error";
      }
    }

    // --- Maintenance Mode ---
    let pinInput = "";
    function handleMaintTap() { document.getElementById('maintenance-modal').style.display = 'flex'; document.getElementById('maint-pin').style.display = 'block'; document.getElementById('maint-dash').style.display = 'none'; pinInput = ""; updatePinDisplay(); }
    function enterPin(val) { if(val === 'C') pinInput = ""; else if(pinInput.length < 4) pinInput += val; updatePinDisplay(); }
    function updatePinDisplay() { document.getElementById('pin-display').innerText = pinInput.padEnd(4, '_').split('').join(' '); }
    function checkPin() {
      if(pinInput === "1234") {
        document.getElementById('maint-pin').style.display = 'none'; document.getElementById('maint-dash').style.display = 'flex';
        ['water','shampoo','detergent','handwash','oil'].forEach(k => document.getElementById('mt-'+k).value = MACHINE.tankLevels[k] || 100);
      } else { showToast("Incorrect PIN"); pinInput = ""; updatePinDisplay(); }
    }
    function updateMaintTanks() {
      ['water','shampoo','detergent','handwash','oil'].forEach(k => MACHINE.tankLevels[k] = document.getElementById('mt-'+k).value);
      localStorage.setItem('rxTanks', JSON.stringify(MACHINE.tankLevels));
    }
    function refillAllTanks() {
      ['water','shampoo','detergent','handwash','oil'].forEach(k => { MACHINE.tankLevels[k] = 100; document.getElementById('mt-'+k).value = 100; });
      updateMaintTanks(); showToast("All tanks refilled to 100%");
    }

    // --- Global Handlers ---
    setInterval(() => { document.getElementById('clock').innerText = new Date().toLocaleTimeString('en-US', { hour12: false }); }, 1000);
    function toggleWiFi() { MACHINE.isOnline = !MACHINE.isOnline; document.getElementById('online-badge').innerText = MACHINE.isOnline ? "ONLINE" : "OFFLINE"; document.getElementById('online-badge').style.background = MACHINE.isOnline ? "var(--green-accent)" : "var(--amber)"; document.getElementById('offline-banner').style.display = MACHINE.isOnline ? "none" : "block"; }
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'e') { e.preventDefault(); showToast("SYSTEM ERROR: Flow sensor blockage detected."); }
      if (e.ctrlKey && e.key.toLowerCase() === 'p') { e.preventDefault(); document.body.style.background = "#000"; document.getElementById('screen-container').style.opacity = '0'; setTimeout(() => { document.body.style.background = "var(--bg)"; document.getElementById('screen-container').style.opacity = '1'; showToast("Power restored — resuming session"); }, 1500); }
    });
  