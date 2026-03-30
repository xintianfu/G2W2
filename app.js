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
let isDrawing = false;
let isGrabbing = false;
let lastDrawUV = null;
let currentGrabHand = null;

// camera
let currentCameraStream = null;

// pinch/input state
let leftHandInput = null;
let rightHandInput = null;
let pinchThreshold = 0.04;
let pinchCooldownMs = 1200;
let lastPinchTime = 0;
let wasPinchingRight = false;

// fist / grab state
let fistThreshold = 0.09;

// panel config
const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

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
  if (xrHelper && xrHelper.baseExperience && xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
    return xrHelper.baseExperience.camera;
  }
  return scene.activeCamera;
}

function getCameraPoseVectors() {
  const cam = getReferenceCamera();
  if (!cam) return null;

  const camPos = cam.globalPosition ? cam.globalPosition.clone() : cam.position.clone();
  const forward = cam.getForwardRay(1).direction.normalize();
  const up = new BABYLON.Vector3(0, 1, 0);
  const right = BABYLON.Vector3.Cross(forward, up).normalize();

  return { cam, camPos, forward, up, right };
}

function placePanelAtRightFront() {
  const data = getCameraPoseVectors();
  if (!data || !snapshotPanel) return;

  const { camPos, forward, right } = data;
  // 放置在右前方一点
  const targetPos = camPos.add(forward.scale(0.62)).add(right.scale(0.15));
  snapshotPanel.position.copyFrom(targetPos);
  snapshotPanel.lookAt(camPos);
  snapshotPanel.setEnabled(true);
}

function placePanelInFront() {
  const data = getCameraPoseVectors();
  if (!data || !snapshotPanel) return;

  const { camPos, forward } = data;
  const targetPos = camPos.add(forward.scale(0.55));
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
  ctx.fillText("READY", 120, 220);
  ctx.font = "40px Arial";
  ctx.fillText("Pinch to Snapshot", 120, 320);
  ctx.fillText("Touch Panel to Draw", 120, 390);
  snapshotTexture.update();
  updatePreviewFromTexture();
}

// ---------- scene ----------
function createScene() {
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

  const camera = new BABYLON.UniversalCamera("desktopCam", new BABYLON.Vector3(0, 1.6, -2), scene);
  camera.attachControl(canvas, true);

  const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
  light.intensity = 1.0;

  const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 8, height: 8 }, scene);
  const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new BABYLON.Color3(0.18, 0.18, 0.2);
  groundMat.alpha = 0.35;
  ground.material = groundMat;

  createSnapshotPanel();
  return scene;
}

function createSnapshotPanel() {
  snapshotPanel = BABYLON.MeshBuilder.CreatePlane("snapshotPanel", {
    width: PANEL_WORLD_WIDTH,
    height: PANEL_WORLD_HEIGHT,
    sideOrientation: BABYLON.Mesh.DOUBLESIDE,
  }, scene);

  snapshotPanel.isPickable = true;
  snapshotPanel.setEnabled(false);

  snapshotTexture = new BABYLON.DynamicTexture("snapshotTexture", { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT }, scene, true);
  snapshotTextureCtx = snapshotTexture.getContext();

  snapshotMaterial = new BABYLON.StandardMaterial("snapshotMat", scene);
  snapshotMaterial.diffuseTexture = snapshotTexture;
  snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
  snapshotMaterial.specularColor = new BABYLON.Color3(0, 0, 0);

  snapshotPanel.material = snapshotMaterial;
  drawPlaceholder();
}

// ---------- camera ----------
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    currentCameraStream = stream;
    video.srcObject = stream;
    await video.play();
    setStatus("Camera ready");
  } catch (err) {
    setStatus(`Camera failed: ${err.message}`);
  }
}

function updateSnapshotFromCurrentVideoFrame() {
  if (!video.videoWidth) return;

  const ctx = snapshotTextureCtx;
  ctx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

  const videoAspect = video.videoWidth / video.videoHeight;
  const texAspect = PANEL_TEX_WIDTH / PANEL_TEX_HEIGHT;

  let drawWidth, drawHeight, offsetX, offsetY;
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

  // Overlay info
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(20, 20, 300, 60);
  ctx.fillStyle = "white";
  ctx.font = "24px Arial";
  ctx.fillText("LIVE SNAPSHOT", 40, 58);

  snapshotTexture.update();
  updatePreviewFromTexture();
  placePanelAtRightFront();
  setStatus("Snapshot Updated");
}

// ---------- XR ----------
async function initXR() {
  xrHelper = await scene.createDefaultXRExperienceAsync({
    uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" },
    optionalFeatures: true,
    inputOptions: { doNotLoadControllerMeshes: true },
  });

  try {
    xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", { xrInput: xrHelper.input });
    xrHelper.input.onControllerAddedObservable.add((inputSource) => {
      if (inputSource.inputSource && inputSource.inputSource.hand) {
        if (inputSource.inputSource.handedness === "left") leftHandInput = inputSource;
        else if (inputSource.inputSource.handedness === "right") rightHandInput = inputSource;
      }
    });
  } catch (e) { console.warn("Hand tracking failed"); }
}

// ---------- drawing logic (Modified) ----------
function getPanelUVFromPointer(pointerInfo) {
  if (!pointerInfo.pickInfo || !pointerInfo.pickInfo.hit) return null;
  if (pointerInfo.pickInfo.pickedMesh !== snapshotPanel) return null;
  return pointerInfo.pickInfo.getTextureCoordinates();
}

function uvToCanvasPoint(uv) {
  if (!uv) return null;
  return { x: uv.x * PANEL_TEX_WIDTH, y: (1 - uv.y) * PANEL_TEX_HEIGHT };
}

function drawLineUV(uv1, uv2) {
  const p1 = uvToCanvasPoint(uv1);
  const p2 = uvToCanvasPoint(uv2);
  const ctx = snapshotTextureCtx;
  ctx.strokeStyle = "#ff3b30";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  snapshotTexture.update();
  updatePreviewFromTexture();
}

function setupPointerLogic() {
  scene.onPointerObservable.add((pointerInfo) => {
    const type = pointerInfo.type;
    const uv = getPanelUVFromPointer(pointerInfo);

    // 直接检测按下，不需要先选中模式
    if (type === BABYLON.PointerEventTypes.POINTERDOWN) {
      if (uv) {
        isDrawing = true;
        lastDrawUV = uv;
        // 画个点
        const p = uvToCanvasPoint(uv);
        snapshotTextureCtx.fillStyle = "#ff3b30";
        snapshotTextureCtx.beginPath();
        snapshotTextureCtx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        snapshotTextureCtx.fill();
        snapshotTexture.update();
      }
      return;
    }

    if (type === BABYLON.PointerEventTypes.POINTERMOVE) {
      if (!isDrawing || !uv) {
        lastDrawUV = null;
        return;
      }
      if (lastDrawUV) drawLineUV(lastDrawUV, uv);
      lastDrawUV = uv;
    }

    if (type === BABYLON.PointerEventTypes.POINTERUP) {
      isDrawing = false;
      lastDrawUV = null;
    }
  });
}

// ---------- Joint Tracking ----------
function getJointPosition(handInput, jointName) {
  if (!handInput || !handInput.inputSource.hand) return null;
  const jointSpace = handInput.inputSource.hand.get(jointName);
  const xrFrame = xrHelper.baseExperience.sessionManager.currentFrame;
  const refSpace = xrHelper.baseExperience.sessionManager.referenceSpace;
  if (!xrFrame || !jointSpace || !refSpace) return null;
  const pose = xrFrame.getJointPose(jointSpace, refSpace);
  return pose ? new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z) : null;
}

function detectPinch(handInput) {
  const thumb = getJointPosition(handInput, "thumb-tip");
  const index = getJointPosition(handInput, "index-finger-tip");
  return (thumb && index) ? BABYLON.Vector3.Distance(thumb, index) < pinchThreshold : false;
}

function detectFist(handInput) {
  const wrist = getJointPosition(handInput, "wrist");
  const index = getJointPosition(handInput, "index-finger-tip");
  return (wrist && index) ? BABYLON.Vector3.Distance(wrist, index) < fistThreshold : false;
}

// ---------- loop updates ----------
function maybeTriggerSnapshotFromPinch() {
  if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;
  const isPinching = detectPinch(rightHandInput);
  if (isPinching && !wasPinchingRight && (nowMs() - lastPinchTime > pinchCooldownMs)) {
    lastPinchTime = nowMs();
    updateSnapshotFromCurrentVideoFrame();
  }
  wasPinchingRight = isPinching;
}

function updateGrabMove() {
  if (isDrawing) return; // 绘画时禁止移动面板
  const leftFist = detectFist(leftHandInput);
  const rightFist = detectFist(rightHandInput);

  if (isGrabbing) {
    const hand = currentGrabHand === "left" ? leftHandInput : rightHandInput;
    const stillFist = currentGrabHand === "left" ? leftFist : rightFist;
    const wrist = getJointPosition(hand, "wrist");
    if (!stillFist || !wrist) {
      isGrabbing = false;
      currentGrabHand = null;
      return;
    }
    snapshotPanel.position.copyFrom(wrist);
    const data = getCameraPoseVectors();
    if (data) snapshotPanel.lookAt(data.camPos);
  } else {
    if (leftFist && BABYLON.Vector3.Distance(getJointPosition(leftHandInput, "wrist"), snapshotPanel.position) < 0.25) {
      isGrabbing = true;
      currentGrabHand = "left";
    } else if (rightFist && BABYLON.Vector3.Distance(getJointPosition(rightHandInput, "wrist"), snapshotPanel.position) < 0.25) {
      isGrabbing = true;
      currentGrabHand = "right";
    }
  }
}

async function bootstrap() {
  engine = new BABYLON.Engine(canvas, true);
  createScene();
  setupPointerLogic();
  await startCamera();
  await initXR();

  engine.runRenderLoop(() => {
    maybeTriggerSnapshotFromPinch();
    updateGrabMove();
    scene.render();
  });
  window.addEventListener("resize", () => engine.resize());
}

bootstrap();