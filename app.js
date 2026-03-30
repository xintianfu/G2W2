const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

const snapshotPreview = document.getElementById("snapshotPreview");
const previewCtx = snapshotPreview.getContext("2d");
snapshotPreview.width = 512;
snapshotPreview.height = 512;

let engine;
let scene;
let xrHelper;

// single panel
let snapshotPanel = null;
let snapshotMaterial = null;
let snapshotTexture = null;
let snapshotTextureCtx = null;

// interaction state
let mode = "browse"; // browse | draw
let isDrawing = false;
let lastDrawPoint = null;

// grab gesture toggles draw mode
let isGrabGestureActive = false;
let activeGrabHand = null;

// camera
let currentCameraStream = null;

// pinch state
let leftHandInput = null;
let rightHandInput = null;

// 更严格的 pinch 判定
let pinchThreshold = 0.025;        // 触发 pinch：2.5cm
let pinchReleaseThreshold = 0.04;  // 必须先张开到 4cm 以上才允许下一次 pinch
let pinchCooldownMs = 1200;
let lastPinchTime = 0;

// armed 机制：必须先 release，再 pinch
let leftPinchArmed = false;
let rightPinchArmed = false;
let leftPinchState = false;
let rightPinchState = false;

// fist / grab state
let fistThreshold = 0.09;

// panel config
const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;
const PANEL_HALF_W = PANEL_WORLD_WIDTH / 2;
const PANEL_HALF_H = PANEL_WORLD_HEIGHT / 2;

// ---------- helpers ----------
function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
  console.log(text);
}

function nowMs() {
  return performance.now();
}

function updatePreviewFromTexture() {
  previewCtx.clearRect(0, 0, snapshotPreview.width, snapshotPreview.height);
  previewCtx.drawImage(
    snapshotTexture.getContext().canvas,
    0,
    0,
    snapshotPreview.width,
    snapshotPreview.height
  );
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

function getCameraPoseVectors() {
  const cam = getReferenceCamera();
  if (!cam) return null;

  const camPos = cam.globalPosition
    ? cam.globalPosition.clone()
    : cam.position.clone();

  const forward = cam.getForwardRay(1).direction.normalize();
  const up = new BABYLON.Vector3(0, 1, 0);
  const right = BABYLON.Vector3.Cross(forward, up).normalize();

  return { cam, camPos, forward, up, right };
}

// 视线左边，持续跟随
function placePanelAtLeftFollow() {
  const data = getCameraPoseVectors();
  if (!data || !snapshotPanel) return;

  const { camPos, forward, right } = data;
  const left = right.scale(-1);

  const forwardOffset = 0.58;
  const leftOffset = 0.36;      // 原来 0.26，现在更靠左
  const verticalOffset = -0.02; // 稍微低一点，可自行调成 0

  const targetPos = camPos
    .add(forward.scale(forwardOffset))
    .add(left.scale(leftOffset))
    .add(new BABYLON.Vector3(0, verticalOffset, 0));

  snapshotPanel.position.copyFrom(targetPos);
  snapshotPanel.lookAt(camPos);
  snapshotPanel.setEnabled(true);
}

function drawPlaceholder() {
  const ctx = snapshotTextureCtx;

  ctx.fillStyle = "#ffcc00";
  ctx.fillRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

  ctx.fillStyle = "#000000";
  ctx.font = "bold 72px Arial";
  ctx.fillText("SNAPSHOT", 120, 220);

  ctx.font = "40px Arial";
  ctx.fillText("pinch = new snapshot", 120, 320);
  ctx.fillText("grab snapshot = toggle draw", 120, 390);
  ctx.fillText("finger draws only on panel", 120, 460);

  snapshotTexture.update();
  updatePreviewFromTexture();
}

function clearDrawingState() {
  isDrawing = false;
  lastDrawPoint = null;
}

function toggleDrawMode() {
  mode = mode === "browse" ? "draw" : "browse";
  clearDrawingState();
  setStatus(`Mode: ${mode}`);
}

// ---------- scene ----------
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

  const ground = BABYLON.MeshBuilder.CreateGround(
    "ground",
    { width: 8, height: 8 },
    scene
  );
  ground.position.y = 0;

  const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new BABYLON.Color3(0.18, 0.18, 0.2);
  groundMat.alpha = 0.35;
  ground.material = groundMat;

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

  snapshotPanel.isPickable = false;
  snapshotPanel.setEnabled(false);

  snapshotTexture = new BABYLON.DynamicTexture(
    "snapshotTexture",
    { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT },
    scene,
    true
  );
  snapshotTexture.hasAlpha = false;
  snapshotTextureCtx = snapshotTexture.getContext();

  snapshotMaterial = new BABYLON.StandardMaterial("snapshotMat", scene);
  snapshotMaterial.diffuseTexture = snapshotTexture;
  snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
  snapshotMaterial.specularColor = new BABYLON.Color3(0, 0, 0);

  snapshotPanel.material = snapshotMaterial;
  drawPlaceholder();
}

// ---------- camera ----------
async function stopCurrentCameraStream() {
  if (currentCameraStream) {
    currentCameraStream.getTracks().forEach((track) => track.stop());
    currentCameraStream = null;
  }
  video.srcObject = null;
}

async function requestEnvironmentCameraExact() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { exact: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });
}

async function requestEnvironmentCameraPreferred() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });
}

async function requestAnyCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });
}

async function startCamera() {
  try {
    await stopCurrentCameraStream();
    setStatus("Requesting camera...");

    let stream = null;

    try {
      stream = await requestEnvironmentCameraExact();
      console.log("Exact environment camera success");
    } catch (err1) {
      console.warn("Exact environment failed:", err1);
      try {
        stream = await requestEnvironmentCameraPreferred();
        console.log("Preferred environment camera success");
      } catch (err2) {
        console.warn("Preferred environment failed:", err2);
        stream = await requestAnyCamera();
        console.log("Fallback camera success");
      }
    }

    currentCameraStream = stream;
    video.srcObject = stream;
    await video.play();

    setStatus("Camera ready");
  } catch (err) {
    console.error(err);
    setStatus(`Camera failed: ${err.message}`);
  }
}

// 每次 pinch 都是新的截图，旧画全部清掉
function updateSnapshotFromCurrentVideoFrame() {
  if (!video.videoWidth || !video.videoHeight) {
    setStatus("No camera frame available");
    return;
  }

  clearDrawingState();

  const ctx = snapshotTextureCtx;
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

  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fillRect(24, 24, 420, 96);
  ctx.fillStyle = "white";
  ctx.font = "bold 36px Arial";
  ctx.fillText("Snapshot", 46, 72);
  ctx.font = "24px Arial";
  ctx.fillText(new Date().toLocaleTimeString(), 46, 102);

  snapshotTexture.update();
  updatePreviewFromTexture();

  snapshotPanel.setEnabled(true);
  placePanelAtLeftFollow();

  setStatus(`Snapshot updated (mode=${mode})`);
}

// ---------- XR ----------
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
      snapshotPanel.setEnabled(false);

      // 进入 XR 时重置 pinch 状态，避免刚进来误触发
      leftPinchArmed = false;
      rightPinchArmed = false;
      leftPinchState = false;
      rightPinchState = false;
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

    xrHelper.input.onControllerAddedObservable.add((inputSource) => {
      if (inputSource.inputSource && inputSource.inputSource.hand) {
        if (inputSource.inputSource.handedness === "left") {
          leftHandInput = inputSource;
          leftPinchArmed = false;
          leftPinchState = false;
          console.log("Left hand detected");
        } else if (inputSource.inputSource.handedness === "right") {
          rightHandInput = inputSource;
          rightPinchArmed = false;
          rightPinchState = false;
          console.log("Right hand detected");
        }
      }
    });

    xrHelper.input.onControllerRemovedObservable.add((inputSource) => {
      if (leftHandInput === inputSource) {
        leftHandInput = null;
        leftPinchArmed = false;
        leftPinchState = false;
      }
      if (rightHandInput === inputSource) {
        rightHandInput = null;
        rightPinchArmed = false;
        rightPinchState = false;
      }
    });
  } catch (err) {
    console.warn("Hand tracking not enabled:", err);
  }
}

// ---------- no pointer drawing in this version ----------
function setupPointerLogic() {
  // 这版完全不用射线/鼠标来绘画
}

// ---------- hand joints ----------
function getXRFrame() {
  if (
    !xrHelper ||
    !xrHelper.baseExperience ||
    !xrHelper.baseExperience.sessionManager
  ) {
    return null;
  }
  return xrHelper.baseExperience.sessionManager.currentFrame || null;
}

function getXRReferenceSpace() {
  if (
    !xrHelper ||
    !xrHelper.baseExperience ||
    !xrHelper.baseExperience.sessionManager
  ) {
    return null;
  }
  return (
    xrHelper.baseExperience.sessionManager.referenceSpace ||
    xrHelper.baseExperience.sessionManager.baseReferenceSpace ||
    null
  );
}

function getJointPosition(handInput, jointName) {
  try {
    if (!handInput || !handInput.inputSource || !handInput.inputSource.hand) {
      return null;
    }

    const jointSpace = handInput.inputSource.hand.get(jointName);
    if (!jointSpace) return null;

    const xrFrame = getXRFrame();
    const referenceSpace = getXRReferenceSpace();

    if (!xrFrame || !referenceSpace) return null;

    const jointPose = xrFrame.getJointPose(jointSpace, referenceSpace);
    if (!jointPose) return null;

    const p = jointPose.transform.position;
    return new BABYLON.Vector3(p.x, p.y, p.z);
  } catch (err) {
    return null;
  }
}

function getPinchDistance(handInput) {
  const thumbTip = getJointPosition(handInput, "thumb-tip");
  const indexTip = getJointPosition(handInput, "index-finger-tip");

  if (!thumbTip || !indexTip) return null;
  return BABYLON.Vector3.Distance(thumbTip, indexTip);
}

function detectFist(handInput) {
  const wrist = getJointPosition(handInput, "wrist");
  const indexTip = getJointPosition(handInput, "index-finger-tip");
  const middleTip = getJointPosition(handInput, "middle-finger-tip");
  const ringTip = getJointPosition(handInput, "ring-finger-tip");
  const pinkyTip = getJointPosition(handInput, "pinky-finger-tip");

  if (!wrist || !indexTip || !middleTip || !ringTip || !pinkyTip) return false;

  const avg =
    (BABYLON.Vector3.Distance(wrist, indexTip) +
      BABYLON.Vector3.Distance(wrist, middleTip) +
      BABYLON.Vector3.Distance(wrist, ringTip) +
      BABYLON.Vector3.Distance(wrist, pinkyTip)) / 4;

  return avg < fistThreshold;
}

function isHandNearPanel(handInput) {
  const wrist = getJointPosition(handInput, "wrist");
  if (!wrist || !snapshotPanel || !snapshotPanel.isEnabled()) return false;
  return BABYLON.Vector3.Distance(wrist, snapshotPanel.position) < 0.28;
}

// ---------- drawing by finger only on panel ----------
function getIndexFingerPanelUV(handInput) {
  const finger = getJointPosition(handInput, "index-finger-tip");
  if (!finger || !snapshotPanel || !snapshotPanel.isEnabled()) return null;

  const inv = BABYLON.Matrix.Invert(snapshotPanel.computeWorldMatrix(true));
  const local = BABYLON.Vector3.TransformCoordinates(finger, inv);

  const inside =
    local.x >= -PANEL_HALF_W &&
    local.x <= PANEL_HALF_W &&
    local.y >= -PANEL_HALF_H &&
    local.y <= PANEL_HALF_H &&
    Math.abs(local.z) < 0.03;

  if (!inside) return null;

  const u = (local.x + PANEL_HALF_W) / PANEL_WORLD_WIDTH;
  const v = (local.y + PANEL_HALF_H) / PANEL_WORLD_HEIGHT;

  return new BABYLON.Vector2(u, v);
}

function uvToCanvasPoint(uv) {
  if (!uv) return null;
  return {
    x: uv.x * PANEL_TEX_WIDTH,
    y: (1 - uv.y) * PANEL_TEX_HEIGHT,
  };
}

function drawDotAtUV(uv) {
  const pt = uvToCanvasPoint(uv);
  if (!pt) return;

  const ctx = snapshotTextureCtx;
  ctx.fillStyle = "#ff3b30";
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
  ctx.fill();

  snapshotTexture.update();
  updatePreviewFromTexture();
}

function drawLinePoints(p1, p2) {
  if (!p1 || !p2) return;

  const ctx = snapshotTextureCtx;
  ctx.strokeStyle = "#ff3b30";
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  snapshotTexture.update();
  updatePreviewFromTexture();
}

function updateFingerDrawing() {
  if (mode !== "draw") {
    clearDrawingState();
    return;
  }

  const drawingHand = rightHandInput || leftHandInput;
  if (!drawingHand) {
    clearDrawingState();
    return;
  }

  const uv = getIndexFingerPanelUV(drawingHand);

  // 手指离开 snapshot 范围，不画
  if (!uv) {
    clearDrawingState();
    return;
  }

  const pt = uvToCanvasPoint(uv);

  if (!isDrawing) {
    isDrawing = true;
    lastDrawPoint = pt;
    drawDotAtUV(uv);
    return;
  }

  drawLinePoints(lastDrawPoint, pt);
  lastDrawPoint = pt;
}

// ---------- XR interactions ----------

// 必须先 release，再 pinch，才触发新的 snapshot
function maybeTriggerSnapshotFromPinch() {
  if (
    !xrHelper ||
    !xrHelper.baseExperience ||
    xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR
  ) {
    return;
  }

  const now = nowMs();

  const leftDist = getPinchDistance(leftHandInput);
  const rightDist = getPinchDistance(rightHandInput);

  // LEFT
  if (leftDist !== null) {
    if (leftDist > pinchReleaseThreshold) {
      leftPinchArmed = true;
      leftPinchState = false;
    } else if (
      leftPinchArmed &&
      leftDist < pinchThreshold &&
      !leftPinchState &&
      now - lastPinchTime > pinchCooldownMs
    ) {
      lastPinchTime = now;
      leftPinchState = true;
      leftPinchArmed = false;

      updateSnapshotFromCurrentVideoFrame();
      placePanelAtLeftFollow();
      setStatus(`Snapshot updated by LEFT pinch (mode=${mode})`);
      return;
    }
  }

  // RIGHT
  if (rightDist !== null) {
    if (rightDist > pinchReleaseThreshold) {
      rightPinchArmed = true;
      rightPinchState = false;
    } else if (
      rightPinchArmed &&
      rightDist < pinchThreshold &&
      !rightPinchState &&
      now - lastPinchTime > pinchCooldownMs
    ) {
      lastPinchTime = now;
      rightPinchState = true;
      rightPinchArmed = false;

      updateSnapshotFromCurrentVideoFrame();
      placePanelAtLeftFollow();
      setStatus(`Snapshot updated by RIGHT pinch (mode=${mode})`);
      return;
    }
  }
}

// 抓住 snapshot 一次 = 进入/退出 draw
function updateGrabToggleDraw() {
  if (
    !xrHelper ||
    !xrHelper.baseExperience ||
    xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR
  ) {
    return;
  }

  const leftFist = detectFist(leftHandInput);
  const rightFist = detectFist(rightHandInput);

  const leftNear = leftHandInput && isHandNearPanel(leftHandInput);
  const rightNear = rightHandInput && isHandNearPanel(rightHandInput);

  if (!isGrabGestureActive) {
    if (leftFist && leftNear) {
      isGrabGestureActive = true;
      activeGrabHand = "left";
      toggleDrawMode();
      return;
    }

    if (rightFist && rightNear) {
      isGrabGestureActive = true;
      activeGrabHand = "right";
      toggleDrawMode();
      return;
    }

    return;
  }

  if (activeGrabHand === "left" && !leftFist) {
    isGrabGestureActive = false;
    activeGrabHand = null;
    return;
  }

  if (activeGrabHand === "right" && !rightFist) {
    isGrabGestureActive = false;
    activeGrabHand = null;
  }
}

// ---------- bootstrap ----------
async function bootstrap() {
  engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });

  createScene();
  setupPointerLogic();

  await startCamera();
  await initXR();

  engine.runRenderLoop(() => {
    // panel 已经生成后，持续跟随到左前方
    if (snapshotPanel && snapshotPanel.isEnabled()) {
      placePanelAtLeftFollow();
    }

    maybeTriggerSnapshotFromPinch();
    updateGrabToggleDraw();
    updateFingerDrawing();

    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });

  setStatus("Ready");
}

bootstrap();