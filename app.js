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

// Panel 资源
let snapshotPanel = null;
let snapshotMaterial = null;
let snapshotTexture = null;
let snapshotTextureCtx = null;

// 交互状态 (去掉了 mode)
let isDrawing = false;
let isGrabbing = false;
let lastDrawUV = null;
let currentGrabHand = null;

// 相机流
let currentCameraStream = null;

// 手势配置
let leftHandInput = null;
let rightHandInput = null;
const pinchThreshold = 0.04;
const pinchCooldownMs = 1200;
let lastPinchTime = 0;
let wasPinchingRight = false;

// 抓取配置
const fistThreshold = 0.09;

// 面板尺寸
const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

// ---------- 工具函数 ----------
function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
  console.log(text);
}

function nowMs() { return performance.now(); }

function updatePreviewFromTexture() {
  previewCtx.clearRect(0, 0, snapshotPreview.width, snapshotPreview.height);
  previewCtx.drawImage(snapshotTexture.getContext().canvas, 0, 0, 512, 512);
}

function getReferenceCamera() {
  if (xrHelper?.baseExperience?.state === BABYLON.WebXRState.IN_XR) {
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
  // 放在右前方
  const targetPos = camPos.add(forward.scale(0.62)).add(right.scale(0.15));
  snapshotPanel.position.copyFrom(targetPos);
  snapshotPanel.lookAt(camPos);
  snapshotPanel.setEnabled(true);
}

// ---------- 核心：截图逻辑 (Snapshot) ----------
function updateSnapshotFromCurrentVideoFrame() {
  if (!video.videoWidth || !video.videoHeight) {
    setStatus("No camera frame available");
    return;
  }

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

  // 装饰 UI
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(30, 30, 350, 80);
  ctx.fillStyle = "white";
  ctx.font = "bold 32px Arial";
  ctx.fillText("Snapshot: " + new Date().toLocaleTimeString(), 50, 80);

  snapshotTexture.update();
  updatePreviewFromTexture();
  placePanelAtRightFront(); // 截图后自动归位到面前
  setStatus("New Snapshot Taken");
}

// ---------- 场景初始化 ----------
function createScene() {
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

  const camera = new BABYLON.UniversalCamera("camera", new BABYLON.Vector3(0, 1.6, -2), scene);
  const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
  
  // 地面预览（AR中通常透明）
  const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 4, height: 4 }, scene);
  const groundMat = new BABYLON.StandardMaterial("gMat", scene);
  groundMat.alpha = 0.2;
  ground.material = groundMat;

  // 创建面板
  snapshotPanel = BABYLON.MeshBuilder.CreatePlane("snapshotPanel", {
    width: PANEL_WORLD_WIDTH,
    height: PANEL_WORLD_HEIGHT,
    sideOrientation: BABYLON.Mesh.DOUBLESIDE,
  }, scene);
  snapshotPanel.setEnabled(false);

  snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT }, scene);
  snapshotTextureCtx = snapshotTexture.getContext();

  snapshotMaterial = new BABYLON.StandardMaterial("sMat", scene);
  snapshotMaterial.diffuseTexture = snapshotTexture;
  snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
  snapshotPanel.material = snapshotMaterial;

  return scene;
}

// ---------- 核心：画笔交互逻辑 ----------
function setupPointerLogic() {
  scene.onPointerObservable.add((pointerInfo) => {
    const type = pointerInfo.type;
    // 获取 UV 坐标 (Babylon 会自动处理射线或近距离触碰)
    const uv = (pointerInfo.pickInfo && pointerInfo.pickInfo.hit && pointerInfo.pickInfo.pickedMesh === snapshotPanel) 
               ? pointerInfo.pickInfo.getTextureCoordinates() : null;

    if (type === BABYLON.PointerEventTypes.POINTERDOWN) {
      if (uv) {
        isDrawing = true;
        lastDrawUV = uv;
        drawDotAtUV(uv);
      }
      return;
    }

    if (type === BABYLON.PointerEventTypes.POINTERMOVE) {
      if (!isDrawing) return;
      if (!uv) {
        lastDrawUV = null;
        return;
      }
      if (lastDrawUV) {
        drawLineUV(lastDrawUV, uv);
      } else {
        drawDotAtUV(uv);
      }
      lastDrawUV = uv;
    }

    if (type === BABYLON.PointerEventTypes.POINTERUP) {
      isDrawing = false;
      lastDrawUV = null;
    }
  });
}

function uvToCanvas(uv) {
  return { x: uv.x * PANEL_TEX_WIDTH, y: (1 - uv.y) * PANEL_TEX_HEIGHT };
}

function drawDotAtUV(uv) {
  const p = uvToCanvas(uv);
  snapshotTextureCtx.fillStyle = "#ff3b30";
  snapshotTextureCtx.beginPath();
  snapshotTextureCtx.arc(p.x, p.y, 6, 0, Math.PI * 2);
  snapshotTextureCtx.fill();
  snapshotTexture.update();
  updatePreviewFromTexture();
}

function drawLineUV(uv1, uv2) {
  const p1 = uvToCanvas(uv1);
  const p2 = uvToCanvas(uv2);
  snapshotTextureCtx.strokeStyle = "#ff3b30";
  snapshotTextureCtx.lineWidth = 10;
  snapshotTextureCtx.lineCap = "round";
  snapshotTextureCtx.beginPath();
  snapshotTextureCtx.moveTo(p1.x, p1.y);
  snapshotTextureCtx.lineTo(p2.x, p2.y);
  snapshotTextureCtx.stroke();
  snapshotTexture.update();
  updatePreviewFromTexture();
}

// ---------- WebXR & 手势检测 ----------
async function startCamera() {
  const constraints = [
    { video: { facingMode: { exact: "environment" } } },
    { video: { facingMode: "environment" } },
    { video: true }
  ];
  for (let c of constraints) {
    try {
      currentCameraStream = await navigator.mediaDevices.getUserMedia(c);
      video.srcObject = currentCameraStream;
      await video.play();
      setStatus("Camera OK");
      return;
    } catch (e) {}
  }
}

async function initXR() {
  xrHelper = await scene.createDefaultXRExperienceAsync({
    uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
  });

  try {
    const feature = xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", { xrInput: xrHelper.input });
    xrHelper.input.onControllerAddedObservable.add((input) => {
      if (input.inputSource.hand) {
        if (input.inputSource.handedness === "left") leftHandInput = input;
        else rightHandInput = input;
      }
    });
  } catch (e) { setStatus("Hand tracking failed"); }
}

function getJointPos(hand, name) {
  if (!hand?.inputSource?.hand) return null;
  const joint = hand.inputSource.hand.get(name);
  const frame = xrHelper.baseExperience.sessionManager.currentFrame;
  const ref = xrHelper.baseExperience.sessionManager.referenceSpace;
  if (!frame || !joint || !ref) return null;
  const pose = frame.getJointPose(joint, ref);
  return pose ? new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z) : null;
}

function detectPinch(hand) {
  const t = getJointPos(hand, "thumb-tip");
  const i = getJointPos(hand, "index-finger-tip");
  return (t && i) ? BABYLON.Vector3.Distance(t, i) < pinchThreshold : false;
}

function detectFist(hand) {
  const w = getJointPos(hand, "wrist");
  const i = getJointPos(hand, "index-finger-tip");
  return (w && i) ? BABYLON.Vector3.Distance(w, i) < fistThreshold : false;
}

// ---------- 循环逻辑 ----------
function updateLoop() {
  // 1. Pinch 截图逻辑
  const isPinching = detectPinch(rightHandInput);
  if (isPinching && !wasPinchingRight && (nowMs() - lastPinchTime > pinchCooldownMs)) {
    lastPinchTime = nowMs();
    updateSnapshotFromCurrentVideoFrame();
  }
  wasPinchingRight = isPinching;

  // 2. 抓取移动面板逻辑 (不画画时生效)
  if (!isDrawing) {
    const rFist = detectFist(rightHandInput);
    if (isGrabbing) {
      const wrist = getJointPos(rightHandInput, "wrist");
      if (!rFist || !wrist) { isGrabbing = false; }
      else {
        snapshotPanel.position.copyFrom(wrist);
        const data = getCameraPoseVectors();
        if (data) snapshotPanel.lookAt(data.camPos);
      }
    } else if (rFist) {
      const wrist = getJointPos(rightHandInput, "wrist");
      if (wrist && BABYLON.Vector3.Distance(wrist, snapshotPanel.position) < 0.2) {
        isGrabbing = true;
      }
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
    updateLoop();
    scene.render();
  });
}

bootstrap();