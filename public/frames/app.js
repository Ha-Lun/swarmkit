document.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('scrubber-canvas');
  const ctx = canvas.getContext('2d');
  
  const preloader = document.getElementById('preloader');
  const preloaderBar = document.getElementById('preloader-bar');
  const preloaderPercentage = document.getElementById('preloader-percentage');
  
  const compass = document.getElementById('compass');
  const frameIndicator = document.getElementById('frame-indicator');
  const seekBar = document.getElementById('seek-bar');
  const autoplayBtn = document.getElementById('autoplay-btn');
  const audioToggle = document.getElementById('audio-toggle');
  const narrativeCards = document.querySelectorAll('.narrative-card');
  const scrubberSection = document.getElementById('scrubber-section');
  
  let frames = [];
  let totalFrames = 81;
  let loadedFrames = 0;
  let currentFrame = 0; // Float for smooth interpolation
  let targetFrame = 0;
  let isAutoplay = false;
  let audioEnabled = false;
  
  // Audio Context
  let audioCtx = null;
  function playTick() {
    if (!audioEnabled) return;
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);
    
    gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.05);
  }

  audioToggle.addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    audioToggle.textContent = audioEnabled ? 'SOUND: ON' : 'SOUND: OFF';
    // initialize context on user gesture
    if (audioEnabled && !audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
    }
  });

  // Load manifest
  try {
    const res = await fetch('manifest.json');
    if (res.ok) {
      const manifest = await res.json();
      if (manifest.frameCount) totalFrames = manifest.frameCount;
    }
  } catch (e) {
    console.log('Manifest not found, using default 81 frames');
  }

  seekBar.max = totalFrames - 1;

  // Preload Images
  function onFrameLoaded() {
    loadedFrames++;
    const pct = Math.round((loadedFrames / totalFrames) * 100);
    preloaderBar.style.width = `${pct}%`;
    preloaderPercentage.textContent = `${pct}%`;
    if (loadedFrames === totalFrames) {
      setTimeout(() => {
        preloader.style.opacity = '0';
        setTimeout(() => preloader.style.display = 'none', 1000);
      }, 500);
      resizeCanvas();
    }
  }

  for (let i = 1; i <= totalFrames; i++) {
    const img = new Image();
    const padded = i.toString().padStart(4, '0');
    img.src = `frame_${padded}.webp`;
    img.onload = onFrameLoaded;
    img.onerror = onFrameLoaded;
    frames.push(img);
  }

  // Canvas Resize (High DPR)
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);
    
    const normalizedFrame = Math.round(currentFrame) % totalFrames;
    const renderFrame = normalizedFrame < 0 ? normalizedFrame + totalFrames : normalizedFrame;
    updateCanvas(renderFrame);
  }
  window.addEventListener('resize', resizeCanvas);

  function updateCanvas(index) {
    const img = frames[index];
    if (img && img.complete && img.naturalWidth > 0) {
      const rect = canvas.parentElement.getBoundingClientRect();
      const canvasRatio = rect.width / rect.height;
      const imgRatio = img.naturalWidth / img.naturalHeight;
      let drawWidth, drawHeight, offsetX, offsetY;

      if (canvasRatio > imgRatio) {
        drawHeight = rect.height;
        drawWidth = img.naturalWidth * (rect.height / img.naturalHeight);
        offsetX = (rect.width - drawWidth) / 2;
        offsetY = 0;
      } else {
        drawWidth = rect.width;
        drawHeight = img.naturalHeight * (rect.width / img.naturalWidth);
        offsetX = 0;
        offsetY = (rect.height - drawHeight) / 2;
      }

      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
    }
  }

  // Main Loop
  let lastRoundedFrame = -1;
  function loop() {
    if (isAutoplay) {
      targetFrame += 0.3;
    }

    // Smooth lerp
    currentFrame += (targetFrame - currentFrame) * 0.1;
    let rawFrame = Math.round(currentFrame);
    
    // Normalize to 0 -> totalFrames - 1
    let normalizedFrame = rawFrame % totalFrames;
    if (normalizedFrame < 0) normalizedFrame += totalFrames;

    if (normalizedFrame !== lastRoundedFrame) {
      updateCanvas(normalizedFrame);
      frameIndicator.textContent = `${(normalizedFrame + 1).toString().padStart(2, '0')} / ${totalFrames}`;
      const degree = Math.round((normalizedFrame / totalFrames) * 360);
      compass.textContent = `${degree}°`;
      
      seekBar.value = normalizedFrame;
      
      if (lastRoundedFrame !== -1) {
          playTick();
      }
      lastRoundedFrame = normalizedFrame;
    }
    
    // Update narrative based on progress (0.0 to 1.0)
    const progress = normalizedFrame / (totalFrames - 1);
    narrativeCards.forEach(card => {
      const start = parseFloat(card.dataset.start);
      const end = parseFloat(card.dataset.end);
      card.classList.toggle('active', progress >= start && progress <= end);
    });

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Scroll Sync
  window.addEventListener('scroll', () => {
    if (isAutoplay) return;
    const rect = scrubberSection.getBoundingClientRect();
    const scrollableDistance = rect.height - window.innerHeight;
    const scrolled = -rect.top;
    
    if (scrolled >= 0 && scrolled <= scrollableDistance) {
      const progress = scrolled / scrollableDistance;
      targetFrame = progress * (totalFrames - 1);
    }
  });

  // Seekbar Sync
  seekBar.addEventListener('input', (e) => {
    isAutoplay = false;
    autoplayBtn.textContent = 'AUTOPLAY';
    autoplayBtn.style.color = '';
    autoplayBtn.style.borderColor = '';
    
    // Smoothly seek
    targetFrame = parseInt(e.target.value, 10);
  });

  // Autoplay
  autoplayBtn.addEventListener('click', () => {
    isAutoplay = !isAutoplay;
    autoplayBtn.textContent = isAutoplay ? 'PAUSE' : 'AUTOPLAY';
    if (isAutoplay) {
      autoplayBtn.style.color = 'var(--accent-gold)';
      autoplayBtn.style.borderColor = 'var(--accent-gold)';
    } else {
      autoplayBtn.style.color = '';
      autoplayBtn.style.borderColor = '';
    }
  });

  // Drag to rotate (unified Pointer Events)
  let isDragging = false;
  let startX = 0;
  canvas.addEventListener('pointerdown', (e) => {
    isDragging = true;
    startX = e.clientX;
    isAutoplay = false;
    autoplayBtn.textContent = 'AUTOPLAY';
    autoplayBtn.style.color = '';
    autoplayBtn.style.borderColor = '';
  });
  window.addEventListener('pointerup', () => isDragging = false);
  window.addEventListener('pointercancel', () => isDragging = false);
  window.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const delta = e.clientX - startX;
    targetFrame += delta * 0.2;
    startX = e.clientX;
  });

});
