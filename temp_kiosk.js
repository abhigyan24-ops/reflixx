
    // === LOCAL CLOUD CLIENT (Replacing Firebase) ===
    const CLOUD_URL = window.location.origin;
    
    // Polyfill Firebase functions
    window.db = "LocalCloud";
    window.fbRef = (db, path) => path;
    
    // Offline Queue System
    function getPending() { return JSON.parse(localStorage.getItem('rxPendingWrites') || '[]'); }
    function savePending(writes) { localStorage.setItem('rxPendingWrites', JSON.stringify(writes)); }

    window.safeSet = async function(path, data) {
      try {
        if(!window.MACHINE.isOnline) throw new Error("Offline");
        await fetch(CLOUD_URL + '/api/set', { method:'POST', body: JSON.stringify({path, data}) });
      } catch(e) {
        const p = getPending(); p.push({ action: 'set', path, data }); savePending(p);
      }
    }
    
    window.safePush = async function(path, data) {
      try {
        if(!window.MACHINE.isOnline) throw new Error("Offline");
        await fetch(CLOUD_URL + '/api/push', { method:'POST', body: JSON.stringify({path, data}) });
      } catch(e) {
        const p = getPending(); p.push({ action: 'push', path, data }); savePending(p);
      }
    }

    window.safeUpdate = async function(path, data) {
      try {
        if(!window.MACHINE.isOnline) throw new Error("Offline");
        await fetch(CLOUD_URL + '/api/update', { method:'POST', body: JSON.stringify({path, data}) });
      } catch(e) {
        const p = getPending(); p.push({ action: 'update', path, data }); savePending(p);
      }
    }
    
    window.fbGet = async function(path) {
       const res = await fetch(CLOUD_URL + '/api/get?path=' + encodeURIComponent(path));
       const data = await res.json();
       return { exists: () => data.value !== null, val: () => data.value };
    }
    window.get = window.fbGet;
    window.ref = window.fbRef;
    
    function savePending(writes) { localStorage.setItem('rxPendingWrites', JSON.stringify(writes)); }
    
    
    
    
    
    let GLOBAL_STATE = {};
    const listeners = [];

    window.fbOnValue = function(path, callback) {
      listeners.push({ path, callback });
    }
    window.onValue = window.fbOnValue;

    function getByPath(d, p) {
      const keys = p.split('/').filter(k=>k);
      let curr = d;
      for(let k of keys) { if(curr && curr[k] !== undefined) curr = curr[k]; else return null; }
      return curr;
    }

    setInterval(async () => {
      try {
        const res = await fetch(CLOUD_URL + '/api/sync');
        if(!res.ok) throw new Error("Server error");
        const data = await res.json();
        
        if(!window.MACHINE.isOnline) {
          window.MACHINE.isOnline = true;
          const pending = getPending();
          if(pending.length > 0) {
             for(let task of pending) {
               try { await fetch(CLOUD_URL + '/api/' + task.action, { method:'POST', body: JSON.stringify({path:task.path, data:task.data}) }); } catch(e){}
             }
             savePending([]);
          }
        }
        
        GLOBAL_STATE = data;
        listeners.forEach(l => {
           const val = getByPath(data, l.path);
           if(val !== null) l.callback({ val: () => val, exists: () => val !== null });
        });
        
        document.getElementById('online-badge').innerText = "ONLINE";
        document.getElementById('online-badge').style.background = "var(--green-accent)";
        document.getElementById('offline-banner').style.display = "none";
      } catch(e) {
        window.MACHINE.isOnline = false;
        document.getElementById('online-badge').innerText = "OFFLINE";
        document.getElementById('online-badge').style.background = "var(--amber)";
        document.getElementById('offline-banner').style.display = "block";
      }
    }, 1500);

           savePending([]);
        }
      }
    });

    onValue(ref(db, 'settings/prices'), (snapshot) => {
      const rxPrices = snapshot.val() || {};
      Object.keys(rxPrices).forEach(k => { if(window.PRODUCTS[k]) window.PRODUCTS[k].price = rxPrices[k]; });
    });

    onValue(ref(db, 'stations/RFX-001/tanks'), (snapshot) => {
      const tanks = snapshot.val();
      if(tanks) window.MACHINE.tankLevels = tanks;
      if(document.getElementById('maint-dash').style.display === 'flex') window.buildMaintUI();
    });
    
    // Heartbeat & Telemetry Loop
    setInterval(() => {
      if(!window.MACHINE.isOnline) return;
      
      safeUpdate(`stations/RFX-001/health`, { lastPing: Date.now() });
      
      // Simulate sensors
      const flow = window.MACHINE.isDispensing ? (1.0 + (Math.random()*0.2 - 0.1)).toFixed(2) : "0.0";
      safeUpdate(`stations/RFX-001/health/sensors`, {
        ultrasonic: { status: "ok", lastReading: "4.2cm", lastUpdate: Date.now() },
        flowSensor: { status: "ok", lastReading: `${flow}L/min`, lastUpdate: Date.now() },
        temperature: { status: "ok", lastReading: `${(24.2 + Math.random()*0.4).toFixed(1)}C`, lastUpdate: Date.now() },
        tds: { status: "ok", lastReading: `${Math.floor(142 + Math.random()*5)}ppm`, lastUpdate: Date.now() },
        qrScanner: { status: "ok", lastReading: "active", lastUpdate: Date.now() }
      });
    }, 15000);

    const LANG = {
      en: {
        idle_title: "Smart Refills. Zero Waste.", idle_tap: "TAP TO START",
        screen4_title: "Place your bottle under the nozzle", screen4_waiting: "Scanning for phone's Bluetooth beacon...", screen4_detected: "Locking position...",
        screen5_title: "Scan your RefillX app QR code",
        auth_step1: "Connecting to RefillX cloud...", auth_step2: "Validating QR signature...", auth_step3: "Checking user account...", auth_step4: "Checking session history...", auth_step5: "Authorising dispense command...",
        btn_start: "BEGIN DISPENSE", btn_cancel: "← Cancel", btn_back: "← Back", btn_demo: "Use Demo QR",
        screen7_live: "Live Mechanism", btn_stop: "EMERGENCY STOP",
        screen8_title: "Dispense Complete!", screen8_pay: "Scan to pay OR use the direct link in your mobile app.", btn_done: "✅ I HAVE PAID"
      },
      hi: {
        idle_title: "स्मार्ट रिफिल। शून्य कचरा।", idle_tap: "शुरू करने के लिए टैप करें",
        screen4_title: "अपनी बोतल नोजल के नीचे रखें", screen4_waiting: "बोतल की प्रतीक्षा...", screen4_detected: "बोतल मिली! ✓",
        screen5_title: "अपना RefillX QR कोड स्कैन करें",
        auth_step1: "RefillX क्लाउड से जुड़ रहे हैं...", auth_step2: "QR हस्ताक्षर सत्यापित कर रहे हैं...", auth_step3: "उपयोगकर्ता खाता जांच रहे हैं...", auth_step4: "सत्र इतिहास जांच रहे हैं...", auth_step5: "डिस्पेंस कमांड अधिकृत कर रहे हैं...",
        btn_start: "भरना शुरू करें", btn_cancel: "← रद्द करें", btn_back: "← वापस", btn_demo: "डेमो QR उपयोग करें",
        screen7_live: "लाइव मैकेनिज्म", btn_stop: "आपातकालीन रोक",
        screen8_title: "भरना पूर्ण!", screen8_pay: "भुगतान के लिए स्कैन करें या अपने मोबाइल ऐप में सीधे लिंक का उपयोग करें।", btn_done: "✅ भुगतान हो गया"
      },
      kn: {
        idle_title: "ಸ್ಮಾರ್ಟ್ ರಿಫಿಲ್. ಶೂನ್ಯ ತ್ಯಾಜ್ಯ.", idle_tap: "ಪ್ರಾರಂಭಿಸಲು ಟ್ಯಾಪ್ ಮಾಡಿ",
        screen4_title: "ನಿಮ್ಮ ಬಾಟಲಿಯನ್ನು ನಳಿಕೆ ಅಡಿಯಲ್ಲಿ ಇರಿಸಿ", screen4_waiting: "ಬಾಟಲಿಗಾಗಿ ಕಾಯುತ್ತಿದೆ...", screen4_detected: "ಬಾಟಲಿ ಪತ್ತೆಯಾಯಿತು! ✓",
        screen5_title: "ನಿಮ್ಮ RefillX QR ಕೋಡ್ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ",
        auth_step1: "RefillX ಕ್ಲೌಡ್ಗೆ ಸಂಪರ್ಕಿಸಲಾಗುತ್ತಿದೆ...", auth_step2: "QR ಸಹಿ ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ...", auth_step3: "ಬಳಕೆದಾರ ಖಾತೆ ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ...", auth_step4: "ಸೆಷನ್ ಇತಿಹಾಸ ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ...", auth_step5: "ಡಿಸ್ಪೆನ್ಸ್ ಆಜ್ಞೆ ಅಧಿಕೃತಗೊಳಿಸಲಾಗುತ್ತಿದೆ...",
        btn_start: "ತುಂಬಿಸುವಿಕೆ ಪ್ರಾರಂಭಿಸಿ", btn_cancel: "← ರದ್ದುಮಾಡಿ", btn_back: "← ಹಿಂದೆ", btn_demo: "ಡೆಮೊ QR ಬಳಸಿ",
        screen7_live: "ಲೈವ್ ಮೆಕ್ಯಾನಿಸಂ", btn_stop: "ತುರ್ತು ನಿಲ್ಲಿಸಿ",
        screen8_title: "ತುಂಬಿಸುವಿಕೆ ಪೂರ್ಣ!", screen8_pay: "ಪಾವತಿಗಾಗಿ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ ಅಥವಾ ನಿಮ್ಮ ಮೊಬೈಲ್ ಅಪ್ಲಿಕೇಶನ್‌ನಲ್ಲಿ ನೇರ ಲಿಂಕ್ ಬಳಸಿ.", btn_done: "✅ ಪಾವತಿ ಆಯಿತು"
      }
    };
    
    let MACHINE_LANG = localStorage.getItem('rxLang') || 'en';
    
    function t(key) { return LANG[MACHINE_LANG] && LANG[MACHINE_LANG][key] ? LANG[MACHINE_LANG][key] : (LANG['en'][key] || key); }
    
    window.setLang = function(l) {
      MACHINE_LANG = l; localStorage.setItem('rxLang', l);
      document.body.style.fontFamily = l === 'kn' ? 'Noto Sans Kannada' : l === 'hi' ? 'Noto Sans Devanagari' : 'DM Sans';
      ['en','hi','kn'].forEach(k => {
        const b = document.getElementById('lang-'+k);
        if(b) b.className = k===l ? 'px-3 py-1 font-bold text-sm bg-[var(--green-bright)] text-black' : 'px-3 py-1 font-bold text-sm text-gray-400';
      });
      refreshLanguage();
    }
    
    function refreshLanguage() {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        if(el.tagName === 'INPUT') el.placeholder = t(el.getAttribute('data-i18n'));
        else el.innerText = t(el.getAttribute('data-i18n'));
      });
    }
    
    setTimeout(() => { window.setLang(MACHINE_LANG); }, 500);

    const canvas = document.createElement('canvas'); canvas.id = 'bg-canvas';
    document.body.insertBefore(canvas, document.body.firstChild);
    const ctx = canvas.getContext('2d');
    let width, height; const particles = [];
    window.resize = function() { width = canvas.width = window.innerWidth; height = canvas.height = window.innerHeight; }
    window.addEventListener('resize', window.resize); window.resize();
    function initParticles() {
        for(let i=0; i<50; i++) { particles.push({ x: Math.random()*width, y: Math.random()*height, size: Math.random()*2+1, speedY: Math.random()*0.5+0.1, alpha: Math.random()*0.5 }); }
    }
    initParticles();
    function animateParticles() {
      ctx.clearRect(0,0,width,height);
      particles.forEach(p => {
        p.y -= p.speedY; if(p.y < -10) { p.y = height + 10; p.x = Math.random()*width; }
        ctx.fillStyle = `rgba(62, 207, 122, ${p.alpha})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
      });
      requestAnimationFrame(animateParticles);
    }
    animateParticles();
    
    const burstCanvas = document.createElement('canvas'); burstCanvas.id = 'particle-burst';
    document.body.appendChild(burstCanvas);
    const bCtx = burstCanvas.getContext('2d');
    let bParticles = [];
    function animateBurst() {
      bCtx.clearRect(0,0,burstCanvas.width,burstCanvas.height);
      if(bParticles.length > 0) {
        bParticles.forEach(p => { p.x += p.vx; p.y += p.vy; p.alpha -= 0.015; bCtx.fillStyle = `rgba(62, 207, 122, ${Math.max(0, p.alpha)})`; bCtx.beginPath(); bCtx.arc(p.x, p.y, p.size, 0, Math.PI*2); bCtx.fill(); });
        bParticles = bParticles.filter(p => p.alpha > 0);
        requestAnimationFrame(animateBurst);
      }
    }
    window.triggerBurst = function() {
      burstCanvas.width = window.innerWidth; burstCanvas.height = window.innerHeight; bParticles = [];
      for(let i=0; i<80; i++) { const angle = Math.random()*Math.PI*2; const speed = Math.random()*15+5; bParticles.push({ x: window.innerWidth/2, y: window.innerHeight/2, vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed, size: Math.random()*5+2, alpha: 1 }); }
      animateBurst();
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const actx = new AudioContext();
    function playTone(freq, type, duration, vol=0.1) {
      if(actx.state === 'suspended') actx.resume();
      const osc = actx.createOscillator(); const gain = actx.createGain();
      osc.type = type; osc.frequency.value = freq; osc.connect(gain); gain.connect(actx.destination);
      gain.gain.setValueAtTime(vol, actx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + duration);
      osc.start(); osc.stop(actx.currentTime + duration);
    }
    window.playTap = function() { playTone(600, 'sine', 0.1, 0.05); }
    window.playSuccess = function() { playTone(500, 'sine', 0.1); setTimeout(()=>playTone(800, 'sine', 0.2), 100); }
    window.playError = function() { playTone(150, 'sawtooth', 0.3, 0.2); }
    let humOsc = null;
    window.startHum = function() {
      if(actx.state === 'suspended') actx.resume();
      humOsc = actx.createOscillator(); const gain = actx.createGain();
      humOsc.type = 'sine'; humOsc.frequency.value = 60; humOsc.connect(gain); gain.connect(actx.destination);
      gain.gain.value = 0.05; humOsc.start();
    }
    window.stopHum = function() { if(humOsc) { humOsc.stop(); humOsc = null; } }

    window.showToastMsg = function(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg; t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    }
    window.showToast = window.showToastMsg;

    let scanLoopId; let videoStream;
    window.startCam = function() {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } }).then(s => {
        videoStream = s; document.getElementById('cam-video').srcObject = s; requestAnimationFrame(scanLoop);
      }).catch(e => { console.warn("Cam disabled", e); });
    }
    window.stopCam = function() {
      if(videoStream) { videoStream.getTracks().forEach(t => t.stop()); }
      cancelAnimationFrame(scanLoopId);
    }

    function scanLoop() {
      const v = document.getElementById('cam-video');
      if (v.readyState === v.HAVE_ENOUGH_DATA && window.MACHINE.screen === 5) {
        const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        const cx = c.getContext('2d'); cx.drawImage(v, 0, 0, c.width, c.height);
        const imgData = cx.getImageData(0,0,c.width,c.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height);
        if(code) { processQR(code.data); return; }
      }
      scanLoopId = requestAnimationFrame(scanLoop);
    }

    window.resetToIdle = function() {
      window.MACHINE = { screen: 1, product: null, quantity: null, pricePer100ml: 0, sessionId: null, dispensedMl: 0, tankLevels: window.MACHINE.tankLevels, isOnline: window.MACHINE.isOnline, authData: null, isDispensing: false, userTier: null };
      window.showScreen(1, 'Welcome', 1);
      document.getElementById('welcome-card').style.transform = 'scale(0.8)';
      document.getElementById('welcome-card').style.opacity = '0';
      setTimeout(() => { document.getElementById('welcome-card').style.transform = 'scale(1)'; document.getElementById('welcome-card').style.opacity = '1'; }, 50);
    }

    window.showScreen = function(id, name, stepIdx) {
      if(!window.MACHINE.isOnline && id !== 1 && id !== 9) { window.showToast("Cannot proceed. Machine is OFFLINE."); return; }
      window.playTap();
      window.MACHINE.screen = id;
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById('screen-'+id).classList.add('active');
      document.getElementById('step-text').innerText = `Step ${stepIdx} of 5: ${name}`;
      
      if(id === 4) initScreen4();
      if(id === 5) { window.startCam(); } else { window.stopCam(); }
      if(id === 6) initScreen6();
      if(id === 7) window.initScreen7();
      if(id === 8) initScreen8();
      if(id === 9) initScreen9();
    }

    window.selectProduct = function(key) {
      window.MACHINE.product = key; window.MACHINE.pricePer100ml = window.PRODUCTS[key].price;
      document.getElementById('prod-title').innerText = window.PRODUCTS[key].name;
      document.getElementById('prod-icon').innerText = window.PRODUCTS[key].icon;
      document.getElementById('prod-price').innerText = `₹${window.MACHINE.pricePer100ml.toFixed(2)} / 100ml`;
      
      const ml = window.MACHINE.tankLevels[key] || 0;
      let availHtml = `Available: ${(ml/1000).toFixed(1)}L`;
      document.getElementById('prod-avail').innerText = availHtml;
      
      window.showScreen(3, 'Quantity', 2);
    }

    function initScreen4() {
      let t = 0; const steps = ['.', '..', '...', '✓'];
      const textNode = document.getElementById('waiting-bottle');
      const waitInt = setInterval(() => {
        if(window.MACHINE.screen !== 4) { clearInterval(waitInt); return; }
        textNode.innerText = t < 3 ? t("screen4_waiting") + " " + steps[t] : t("screen4_detected");
        if(t === 3) {
           clearInterval(waitInt); window.playSuccess();
           setTimeout(() => { window.showScreen(5, 'Auth', 3); }, 1500);
        }
        t++;
      }, 800);
    }

    window.processQR = async function(dataStr) {
      try {
        const payload = JSON.parse(dataStr);
        if(!payload.sid || !payload.prod || !payload.qty || !payload.exp) throw new Error("Invalid payload");
        if(payload.exp < Date.now()) throw new Error("QR Code Expired");
        
        window.stopCam();
        window.MACHINE.sessionId = payload.sid;
        window.MACHINE.product = payload.prod;
        window.MACHINE.pricePer100ml = window.PRODUCTS[payload.prod].price;
        const reqQty = parseInt(payload.qty);
        const availMl = window.MACHINE.tankLevels[payload.prod] || 0;
        window.MACHINE.authData = payload; 

        if(reqQty > availMl) {
          if(availMl < 50) throw new Error("Tank is completely empty.");
          window.MACHINE.quantity = availMl;
          window.showToast(`Only ${availMl.toFixed(0)}ml left in machine. Filling that much.`);
        } else {
          window.MACHINE.quantity = reqQty;
        }

        // Fetch user tier for discounts
        if(payload.uid) {
           const snap = await get(ref(db, `users/${payload.uid}/profile/tier`));
           if(snap.exists()) window.MACHINE.userTier = snap.val();
        }

        window.playSuccess();
        document.getElementById('qr-error').innerText = "QR Verified ✓";
        document.getElementById('qr-error').style.color = "var(--green-bright)";
        document.querySelectorAll('.scan-bracket').forEach(b => b.classList.add('pulse-glow'));
        
        setTimeout(() => { window.stopCam(); window.showScreen(6, 'Authentication', 3); }, 1000);
      } catch(e) {
        window.playError(); document.getElementById('qr-error').innerText = e.message || "Invalid QR format"; document.getElementById('qr-error').style.color = "var(--red)"; document.getElementById('video-box').classList.add('shake');
        setTimeout(() => document.getElementById('video-box').classList.remove('shake'), 400); setTimeout(() => requestAnimationFrame(scanLoop), 1500);
      }
    }

    window.demoQR = function() { 
      window.processQR(JSON.stringify({ sid: "RFX-"+Date.now().toString(36).toUpperCase(), name: "Divyansh Singh", email: "divyansh@example.com", prod: "water", qty: 500, exp: Date.now()+100000 })); 
    }

    function initScreen6() {
      document.getElementById('auth-success').classList.add('hidden');
      for(let i=1; i<=5; i++) document.getElementById(`chk-${i}`).className = 'checklist-item';
      
      const delays = [600, 800, 700, 600, 500]; let cumulative = 0;
      for(let i=1; i<=5; i++) {
        cumulative += delays[i-1];
        setTimeout(() => {
          document.getElementById(`chk-${i}`).className = 'checklist-item done'; window.playTap();
          if(i===5) {
            setTimeout(() => {
              document.getElementById('auth-success').classList.remove('hidden');
              document.getElementById('auth-name').innerText = window.MACHINE.authData.name || "RefillX Member";
              document.getElementById('auth-email').innerText = window.MACHINE.authData.email || "";
              document.getElementById('auth-initials').innerText = (window.MACHINE.authData.name || "RM").substring(0,2).toUpperCase();
              document.getElementById('auth-order-desc').innerText = `${window.MACHINE.quantity.toFixed(0)}ml ${window.PRODUCTS[window.MACHINE.product].name}`;
              document.getElementById('auth-order-price').innerText = `₹${((window.MACHINE.quantity/100)*window.MACHINE.pricePer100ml).toFixed(2)}`;
              window.playSuccess();
              
              // Register Session in Firebase as 'pending'
              safeUpdate(`logs/sessions/${window.MACHINE.sessionId}`, { status: 'pending' });
              
            }, 500);
          }
        }, cumulative);
      }
    }

    window.startDispense = function() { window.showScreen(7, 'Dispensing', 4); }
    window.initScreen7 = function() {
      window.MACHINE.isDispensing = true;
      window.MACHINE.dispensedMl = 0;
      
      safeUpdate(`logs/sessions/${window.MACHINE.sessionId}`, { status: 'dispensing' });
      safeUpdate(`stations/RFX-001/dispense`, { status: 'dispensing', progress: 0 });

      let flow = 1.0; 
      let sparkData = Array(12).fill(flow);
      document.getElementById('m-solenoid').innerText = "OPEN"; document.getElementById('m-solenoid').className = "solenoid open";
      document.getElementById('m-stream').style.height = "250px";
      document.getElementById('disp-target').innerText = `/ ${window.MACHINE.quantity.toFixed(0)} ml`;
      
      const pColor = window.PRODUCTS[window.MACHINE.product].color;
      document.getElementById('m-tank-liquid').style.background = pColor; document.getElementById('m-bottle-liquid').style.background = pColor; document.getElementById('m-stream').style.background = pColor;
      document.getElementById('m-tank-liquid').style.height = (window.MACHINE.tankLevels[window.MACHINE.product]/100) + "%"; document.getElementById('m-bottle-liquid').style.height = "0%";
      window.startHum();
      
      const drops = [];
      for(let i=0; i<5; i++) { const d = document.createElement('div'); d.className='droplet'; d.style.background=pColor; d.style.animation = `dropFall 0.4s infinite linear ${i*0.1}s`; document.querySelector('.machine-visual').appendChild(d); drops.push(d); }
      
      window.dispenseInterval = setInterval(() => {
        let mlPerTick = 3.3333;
        window.MACHINE.dispensedMl += mlPerTick;
        if (window.MACHINE.dispensedMl >= window.MACHINE.quantity) { window.MACHINE.dispensedMl = window.MACHINE.quantity; window.finishDispense(drops); }
        
        document.getElementById('disp-ml').innerText = Math.floor(window.MACHINE.dispensedMl);
        let pct = window.MACHINE.dispensedMl / window.MACHINE.quantity;
        document.getElementById('disp-gauge').style.strokeDashoffset = 628 - (628 * pct);
        document.getElementById('m-bottle-liquid').style.height = (pct * 90) + "%";
        
        safeUpdate(`stations/RFX-001/dispense`, { progress: Math.floor(pct * 100) });
        
        let tankPct = (window.MACHINE.tankLevels[window.MACHINE.product] / 10000) * 100;
        document.getElementById('m-tank-liquid').style.height = tankPct + "%";
        
        if (Math.random() > 0.6) {
          const b = document.createElement('div'); b.className = 'bottle-bubble'; 
          b.style.width = Math.random()*10+5+'px'; b.style.height = b.style.width;
          b.style.left = Math.random()*80+10+'%'; 
          document.getElementById('m-bottle-liquid').appendChild(b);
          setTimeout(() => b.remove(), 1500);
        }
        
        document.getElementById('disp-flow').innerHTML = `${flow.toFixed(1)} <span class="text-lg text-white">L/m</span>`;
        document.getElementById('disp-temp').innerHTML = `${(24.2 + Math.random()*0.4).toFixed(1)} <span class="text-lg text-white">°C</span>`;
        document.getElementById('disp-tds').innerHTML = `${Math.floor(142 + Math.random()*5)} <span class="text-lg text-white">ppm</span>`;
        
        let timeLeft = ((window.MACHINE.quantity - window.MACHINE.dispensedMl) / (flow*1000/60)).toFixed(0);
        document.getElementById('disp-time').innerHTML = `0:${timeLeft.padStart(2,'0')} <span class="text-lg text-white">s</span>`;
        
        sparkData.shift(); sparkData.push(flow);
        let pts = sparkData.map((v, i) => `${i*5},${60 - (v*20)}`).join(' ');
        document.getElementById('disp-spark').setAttribute('points', pts);
      }, 200);
    }
    
    window.emergencyStop = function() { if(!window.MACHINE.isDispensing) return; window.showToast("EMERGENCY STOP. Valve closed."); window.playError(); window.finishDispense([], true); }
    
    window.finishDispense = function(drops=[], isEstop=false) {
      clearInterval(window.dispenseInterval); window.MACHINE.isDispensing = false; window.stopHum();
      document.getElementById('m-solenoid').innerText = "CLOSED"; document.getElementById('m-solenoid').className = "solenoid";
      document.getElementById('m-stream').style.height = "0"; drops.forEach(d => d.remove());
      
      safeUpdate(`logs/sessions/${window.MACHINE.sessionId}`, { status: 'dispensed' });
      safeUpdate(`stations/RFX-001/dispense`, { status: 'complete', progress: 100 });
      
      if (window.MACHINE.product && window.MACHINE.tankLevels[window.MACHINE.product] !== undefined) {
        const newMl = Math.max(0, window.MACHINE.tankLevels[window.MACHINE.product] - window.MACHINE.dispensedMl);
        safeUpdate(`stations/RFX-001/tanks`, { [window.MACHINE.product]: newMl });
      }
      
      const finalAmt = ((window.MACHINE.dispensedMl/100) * window.MACHINE.pricePer100ml).toFixed(2);
      
      // Log session
      safeUpdate(`sessions/${window.MACHINE.sessionId}`, {
        id: window.MACHINE.sessionId, stationId: 'RFX-001', userId: window.MACHINE.authData.uid || 'guest',
        product: window.MACHINE.product, quantity: window.MACHINE.dispensedMl, amount: finalAmt,
        timestamp: Date.now(), duration: (window.MACHINE.dispensedMl / (1.0*1000/60)).toFixed(0)
      });

      if(!isEstop) { window.playSuccess(); setTimeout(() => { window.triggerBurst(); window.showScreen(8, 'Payment', 5); }, 1500); } else { setTimeout(window.resetToIdle, 3000); }
    }

    function initScreen8() {
      document.getElementById('success-anim').style.display = 'block'; document.getElementById('payment-box').style.display = 'none';
      document.getElementById('pay-summary-text').innerText = `${Math.floor(window.MACHINE.dispensedMl)}ml ${window.PRODUCTS[window.MACHINE.product].name} refilled successfully`;
      setTimeout(() => {
        document.getElementById('success-anim').style.display = 'none'; document.getElementById('payment-box').style.display = 'block';
        
        let amt = ((window.MACHINE.dispensedMl/100) * window.MACHINE.pricePer100ml);
        let discHtml = "";
        if(window.MACHINE.userTier && window.MACHINE.userTier.discount > 0) {
           const disc = amt * window.MACHINE.userTier.discount;
           amt = amt - disc;
           discHtml = `<div class="text-[#3ecf7a] font-bold text-lg mb-2">🎁 ${window.MACHINE.userTier.name} discount: -${window.MACHINE.userTier.discount*100}% applied</div>`;
        }
        amt = amt.toFixed(2);
        
        document.getElementById('pay-amt').innerHTML = discHtml + `₹${amt}`;
        
        const upiName = encodeURIComponent("Divyansh Singh");
        const upiLink = `upi://pay?pa=refillx@demo&pn=${upiName}&am=${amt}&cu=INR`;
        document.getElementById('kiosk-upi-qr').innerHTML = "";
        new QRCode(document.getElementById('kiosk-upi-qr'), { text: upiLink, width: 220, height: 220, colorDark: "#000", colorLight: "#fff" });
        
        let t = 300;
        const timerInt = setInterval(async () => {
          if(window.MACHINE.screen !== 8) clearInterval(timerInt); t--;
          document.getElementById('pay-timer').innerText = `${Math.floor(t/60)}:${(t%60).toString().padStart(2,'0')}`;
          
          try {
            const snap = await get(ref(db, `logs/sessions/${window.MACHINE.sessionId}/status`));
            if(snap.val() === 'complete' && window.MACHINE.screen === 8) {
               clearInterval(timerInt); window.completePayment(true);
            }
          } catch(e) {}
          if(t<=0) window.resetToIdle();
        }, 1000);
      }, 3000);
    }
    
    window.completePayment = function(skipFirebaseUpdate = false) {
      if (!skipFirebaseUpdate) safeUpdate(`logs/sessions/${window.MACHINE.sessionId}`, { status: 'complete' });
      window.showScreen(9, 'Complete', 5);
      window.generateReceipt();
    }
    window.generateReceipt = initScreen9; 

    function initScreen9() {
      const d = new Date();
      document.getElementById('r-date').innerText = d.toLocaleDateString(); document.getElementById('r-time').innerText = d.toLocaleTimeString();
      document.getElementById('r-txn').innerText = window.MACHINE.sessionId || "TXN-DEMO123";
      document.getElementById('r-user').innerText = (window.MACHINE.authData && window.MACHINE.authData.name) ? window.MACHINE.authData.name : "Guest";
      document.getElementById('r-prod').innerText = `${window.PRODUCTS[window.MACHINE.product].name} (${Math.floor(window.MACHINE.dispensedMl)}ml)`;
      
      let amt = ((window.MACHINE.dispensedMl/100) * window.MACHINE.pricePer100ml);
      if(window.MACHINE.userTier && window.MACHINE.userTier.discount > 0) amt = amt - (amt * window.MACHINE.userTier.discount);
      document.getElementById('r-amt').innerText = `₹${amt.toFixed(2)}`;
      document.getElementById('r-unit').innerText = `₹${window.MACHINE.pricePer100ml.toFixed(2)} / 100ml`;
      document.getElementById('r-pts').innerText = '+' + Math.floor(window.MACHINE.dispensedMl/10); document.getElementById('r-co2').innerText = Math.floor(window.MACHINE.dispensedMl * 0.024) + 'g';
      document.getElementById('r-qr').innerHTML = ""; new QRCode(document.getElementById('r-qr'), { text: window.MACHINE.sessionId, width: 128, height: 128 });
    }

    // Maintenance Mode
    let pinInput = "";
    window.handleMaintTap = function() { document.getElementById('maintenance-modal').style.display = 'flex'; document.getElementById('maint-pin').style.display = 'block'; document.getElementById('maint-dash').style.display = 'none'; pinInput = ""; window.updatePinDisplay(); }
    window.enterPin = function(val) { if(val === 'C') pinInput = ""; else if(pinInput.length < 4) pinInput += val; window.updatePinDisplay(); }
    window.updatePinDisplay = function() { document.getElementById('pin-display').innerText = pinInput.padEnd(4, '_').split('').join(' '); }
    
    window.buildMaintUI = function() {
      const grid = document.getElementById('maint-tanks-grid');
      grid.innerHTML = '';
      Object.keys(window.PRODUCTS).forEach(k => {
        const ml = window.MACHINE.tankLevels[k] || 0;
        grid.innerHTML += `
          <div class="bg-[#111] p-4 rounded-xl border border-[#333]">
            <label class="block mb-2 font-bold text-gray-400">${window.PRODUCTS[k].name}</label>
            <div class="flex items-center gap-4">
              <span class="text-2xl font-mono text-white w-20" id="maint-lbl-${k}">${(ml/1000).toFixed(1)} L</span>
              <button class="btn btn-outline text-xs px-3 py-1 min-h-0 h-10 flex-1" onclick="addMaintLitres('${k}', 1)">+1L</button>
              <button class="btn btn-outline text-xs px-3 py-1 min-h-0 h-10 flex-1" onclick="addMaintLitres('${k}', -1)">-1L</button>
            </div>
          </div>
        `;
      });
    }
    
    window.addMaintLitres = function(k, liters) {
      const currentMl = window.MACHINE.tankLevels[k] || 0;
      const newMl = Math.min(10000, Math.max(0, currentMl + (liters * 1000)));
      safeUpdate(`stations/RFX-001/tanks`, { [k]: newMl });
    }

    window.checkPin = function() {
      if(pinInput === "1234") { document.getElementById('maint-pin').style.display = 'none'; document.getElementById('maint-dash').style.display = 'flex'; window.buildMaintUI(); }
      else { window.showToastMsg("Incorrect PIN"); pinInput = ""; window.updatePinDisplay(); }
    }
    window.refillAllTanks = function() {
      safeUpdate(`stations/RFX-001/tanks`, { water:10000, shampoo:10000, detergent:10000, handwash:10000, oil:10000 });
      window.showToastMsg("All tanks refilled to 10 Liters.");
    }

    setInterval(() => { document.getElementById('clock').innerText = new Date().toLocaleTimeString('en-US', { hour12: false }); }, 1000);
  