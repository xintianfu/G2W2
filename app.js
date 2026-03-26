const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");

const startCameraBtn = document.getElementById("startCameraBtn");
const takeSnapshotBtn = document.getElementById("takeSnapshotBtn");
const toggleDrawBtn = document.getElementById("toggleDrawBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");

let engine;
let scene;
let xrHelper;

let snapshotPanel = null;
let snapshotMaterial = null;
let snapshotTexture = null;
let snapshotTextureCtx = null;

let isDrawMode = false;
let isDrawing = false;
let isDragging = false;

let lastUV = null;
let currentCameraStream = null;

const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
  console.log(text);
}

function createScene() {
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

  const camera = new BABYLON.UniversalCamera(
    "desktopCam",
    new BABYLON.Vector3(0, 1.6, -2),
    scene
  );
  camera.attachControl(canvas, true);
  camera.speed = 0.08;

  const light = new BABYLON.HemisphericLight(
    "light",
    new BABYLON.Vector3(0, 1, 0),
    scene
  );
  light.intensity = 1.0;

  const env = BABYLON.MeshBuilder.CreateGround(
    "ground",
    { width: 8, height: 8 },
    scene
  );
  env.position.y = 0;

  const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new BABYLON.Color3(0.18, 0.18, 0.2);
  groundMat.alpha = 0.35;
  env.material = groundMat;

  createSnapshotPanel();

  return scene;
}

function createSnapshotPanel() {
  snapshotPanel = BABYLON.MeshBuilder.CreatePlane(
    "snapshotPanel",
    {
      width: PANEL_WORLD_WIDTH,
      height: PANEL_WORLD_HEIGHT,
      sideOrientation: BABYLON.Mesh.DOUBLESIDE,
    },
    scene
  );

  snapshotPanel.isPickable = true;
  snapshotPanel.setEnabled(false);

  snapshotTexture = new BABYLON.DynamicTexture(
    "snapshotTexture",
    { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT },
    scene,
    true
  );
  snapshotTexture.hasAlpha = false;

  snapshotTextureCtx = snapshotTexture.getContext();

  // Initial placeholder
  drawPlaceholder();

  snapshotMaterial = new BABYLON.StandardMaterial("snapshotMat", scene);
  snapshotMaterial.diffuseTexture = snapshotTexture;
  snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
  snapshotMaterial.specularColor = new BABYLON.Color3(0, 0, 0);

  snapshotPanel.material = snapshotMaterial;
}

function drawPlaceholder() {
  const ctx = snapshotTextureCtx;

  ctx.fillStyle = "#1f2430";
  ctx.fillRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

  ctx.fillStyle = "#2b3242";
  ctx.fillRect(60, 60, PANEL_TEX_WIDTH - 120, PANEL_TEX_HEIGHT - 120);

  ctx.fillStyle = "white";
  ctx.font = "bold 52px Arial";
  ctx.fillText("Snapshot Panel", 110, 180);

  ctx.font = "34px Arial";
  ctx.fillText("Start camera and take snapshot", 110, 260);
  ctx.fillText("Draw mode OFF = drag panel", 110, 330);
  ctx.fillText("Draw mode ON = ink on panel", 110, 400);

  snapshotTexture.update();
}

async function initXR() {
  xrHelper = await scene.createDefaultXRExperienceAsync({
    uiOptions: {
      sessionMode: "immersive-ar",
      referenceSpaceType: "local-floor",
    },
    optionalFeatures: true,
    inputOptions: {
      doNotLoadControllerMeshes: true,
    },
  });

  tryEnableHandTracking();

  xrHelper.baseExperience.onStateChangedObservable.add((state) => {
    if (state === BABYLON.WebXRState.IN_XR) {
      setStatus("Entered AR");
    } else if (state === BABYLON.WebXRState.ENTERING_XR) {
      setStatus("Entering AR...");
    } else if (state === BABYLON.WebXRState.EXITING_XR) {
      setStatus("Exiting AR...");
    } else if (state === BABYLON.WebXRState.NOT_IN_XR) {
      setStatus("Not in XR");
    }
  });
}

function tryEnableHandTracking() {
  try {
    xrHelper.baseExperience.featuresManager.enableFeature(
      BABYLON.WebXRFeatureName.HAND_TRACKING,
      "latest",
      {
        xrInput: xrHelper.input,
      }
    );
    console.log("Hand tracking feature requested.");
  } catch (err) {
    console.warn("Hand tracking not enabled:", err);
  }
}

function getReferenceCamera() {
  if (
    xrHelper &&
    xrHelper.baseExperience &&
    xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR
  ) {
    return xrHelper.baseExperience.camera;
  }
  return scene.activeCamera;
}

function spawnPanelOnRight() {
  const cam = getReferenceCamera();
  if (!cam) return;

  const camPos = cam.globalPosition
    ? cam.globalPosition.clone()
    : cam.position.clone();

  const forward = cam.getForwardRay(1).direction.normalize();
  const up = new BABYLON.Vector3(0, 1, 0);
  const right = BABYLON.Vector3.Cross(forward, up).normalize();

  const targetPos = camPos
    .add(forward.scale(0.55))
    .add(right.scale(0.35))
    .add(up.scale(-0.05));

  snapshotPanel.position.copyFrom(targetPos);
  snapshotPanel.lookAt(camPos);
  snapshotPanel.rotate(BABYLON.Axis.Y, Math.PI, BABYLON.Space.LOCAL);

  snapshotPanel.setEnabled(true);
}

async function startCamera() {
  try {
    setStatus("Requesting camera permission...");

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    currentCameraStream = stream;
    video.srcObject = stream;
    video.style.display = "block";

    await video.play();
    setStatus("Camera ready");
  } catch (err) {
    console.error(err);
    setStatus(`Camera failed: ${err.message}`);
  }
}

function takeSnapshotFromVideo() {
  if (!video.videoWidth || !video.videoHeight) {
    setStatus("No camera frame available, using placeholder");
    drawPlaceholder();
    spawnPanelOnRight();
    return;
  }

  const ctx = snapshotTextureCtx;

  // draw camera frame
  ctx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

  const videoAspect = video.videoWidth / video.videoHeight;
  const texAspect = PANEL_TEX_WIDTH / PANEL_TEX_HEIGHT;

  let drawWidth;
  let drawHeight;
  let offsetX;
  let offsetY;

  if (videoAspect > texAspect) {
    drawHeight = PANEL_TEX_HEIGHT;
    drawWidth = drawHeight * videoAspect;
    offsetX = (PANEL_TEX_WIDTH - drawWidth) / 2;
    offsetY = 0;
  } else {
    drawWidth = PANEL_TEX_WIDTH;
    drawHeight = drawWidth / videoAspect;
    offsetX = 0;
    offsetY = (PANEL_TEX_HEIGHT - drawHeight) / 2;
  }

  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
  ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

  // overlay title
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fillRect(24, 24, 370, 84);
  ctx.fillStyle = "white";
  ctx.font = "bold 36px Arial";
  ctx.fillText("Snapshot", 46, 72);
  ctx.font = "24px Arial";
  ctx.fillText(new Date().toLocaleTimeString(), 46, 102);

  snapshotTexture.update();
  spawnPanelOnRight();
  setStatus("Snapshot created");
}

function clearInkOnly() {
  // Recreate snapshot from the current video frame if available
  takeSnapshotFromVideo();
}

function getPanelUVFromPointer(pointerInfo) {
  if (!pointerInfo.pickInfo || !pointerInfo.pickInfo.hit) return null;
  if (pointerInfo.pickInfo.pickedMesh !== snapshotPanel) return null;

  if (typeof pointerInfo.pickInfo.getTextureCoordinates === "function") {
    const uv = pointerInfo.pickInfo.getTextureCoordinates();
    if (uv) return uv;
  }

  return pointerInfo.pickInfo.bu !== undefined && pointerInfo.pickInfo.bv !== undefined
    ? new BABYLON.Vector2(pointerInfo.pickInfo.bu, pointerInfo.pickInfo.bv)
    : null;
}

function uvToCanvasPoint(uv) {
  if (!uv) return null;

  const x = uv.x * PANEL_TEX_WIDTH;
  const y = (1 - uv.y) * PANEL_TEX_HEIGHT;

  return { x, y };
}

function drawDotAtUV(uv) {
  const pt = uvToCanvasPoint(uv);
  if (!pt) return;

  const ctx = snapshotTextureCtx;
  ctx.fillStyle = "#ff4d4f";
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
  ctx.fill();
  snapshotTexture.update();
}

function drawLineUV(uv1, uv2) {
  const p1 = uvToCanvasPoint(uv1);
  const p2 = uvToCanvasPoint(uv2);
  if (!p1 || !p2) return;

  const ctx = snapshotTextureCtx;
  ctx.strokeStyle = "#ff4d4f";
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  snapshotTexture.update();
}

function updateDraggedPanel() {
  if (!isDragging || !snapshotPanel.isEnabled()) return;

  const cam = getReferenceCamera();
  if (!cam) return;

  const camPos = cam.globalPosition
    ? cam.globalPosition.clone()
    : cam.position.clone();

  const forward = cam.getForwardRay(1).direction.normalize();

  snapshotPanel.position.copyFrom(camPos.add(forward.scale(0.5)));
  snapshotPanel.lookAt(camPos);
  snapshotPanel.rotate(BABYLON.Axis.Y, Math.PI, BABYLON.Space.LOCAL);
}

function setDrawMode(on) {
  isDrawMode = on;
  toggleDrawBtn.textContent = `Draw: ${on ? "ON" : "OFF"}`;
  setStatus(on ? "Draw mode enabled" : "Drag mode enabled");
}

function setupPointerLogic() {
  scene.onPointerObservable.add((pointerInfo) => {
    const type = pointerInfo.type;
    const uv = getPanelUVFromPointer(pointerInfo);

    if (type === BABYLON.PointerEventTypes.POINTERDOWN) {
      if (!pointerInfo.pickInfo || !pointerInfo.pickInfo.hit) return;
      if (pointerInfo.pickInfo.pickedMesh !== snapshotPanel) return;

      if (isDrawMode) {
        isDrawing = true;
        lastUV = uv;
        if (uv) drawDotAtUV(uv);
      } else {
        isDragging = true;
      }
    }

    if (type === BABYLON.PointerEventTypes.POINTERMOVE) {
      if (isDrawMode && isDrawing && uv) {
        if (lastUV) {
          drawLineUV(lastUV, uv);
        } else {
          drawDotAtUV(uv);
        }
        lastUV = uv;
      }
    }

    if (type === BABYLON.PointerEventTypes.POINTERUP) {
      isDrawing = false;
      isDragging = false;
      lastUV = null;
    }
  });
}

async function bootstrap() {
  engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });

  createScene();
  setupPointerLogic();
  await initXR();

  engine.runRenderLoop(() => {
    updateDraggedPanel();
    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });

  setStatus("Ready");
}

startCameraBtn.addEventListener("click", async () => {
  await startCamera();
});

takeSnapshotBtn.addEventListener("click", () => {
  takeSnapshotFromVideo();
});

toggleDrawBtn.addEventListener("click", () => {
  setDrawMode(!isDrawMode);
});

clearBtn.addEventListener("click", () => {
  clearInkOnly();
});

window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "d") {
    setDrawMode(!isDrawMode);
  }
  if (e.key.toLowerCase() === "s") {
    takeSnapshotFromVideo();
  }
});

bootstrap();