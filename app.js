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

// 交互状态 (彻底移除 mode，改为布尔值控制)
let isDrawing = false;
let isGrabbing = false;
let lastDrawUV = null;
let currentGrabHand = null;

// 相机流
let currentCameraStream = null;

// 手势配置
let leftHandInput = null;
let rightHandInput = null;
const pinchThreshold = 0.02;
const pinchCooldownMs = 1000; // 稍微缩短冷却时间，提升手感
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
  previewCtx.clearRect(0, 0, 512, 512);
  previewCtx.drawImage(snapshotTexture.getContext().canvas, 0, 0, 512, 512);
}

// 获取当前 XR 相机或普通相机的姿态
function getCameraPoseVectors() {
  let cam = null;
  if (xrHelper && xrHelper.baseExperience && xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
    cam = xrHelper.baseExperience.camera;
  } else {
    cam = scene.activeCamera;
  }

  if (!cam) return null;

  const camPos = cam.globalPosition ? cam.globalPosition.clone() : cam.position.clone();
  const forward = cam.getForwardRay(1).direction.normalize();
  const up = new BABYLON.Vector3(0, 1, 0);
  const right = BABYLON.Vector3.Cross(forward, up).normalize();

  return { camPos, forward, right };
}

// 核心修复：截图后将面板移动到当前视线前方
function placePanelAtCurrentView() {
  const data = getCameraPoseVectors();
  if (!data || !snapshotPanel) return;

  const { camPos, forward, right } = data;
  
  // 放在当前转头方向的前方 0.6米，左侧 0.1米
  const targetPos = camPos.add(forward.scale(0.6)).add(left.scale(0.1));
  
  snapshotPanel.position.copyFrom(targetPos);
  snapshotPanel.lookAt(camPos); // 面板始终面向用户
  snapshotPanel.setEnabled(true);
}

// ---------- 核心：截图逻辑 (Snapshot) ----------
function updateSnapshotFromCurrentVideoFrame() {
  if (!video.videoWidth || !video.videoHeight) {
    setStatus("Camera stream not ready");
    return;
  }

  const ctx = snapshotTextureCtx;
  // 清除上一张图和红笔墨迹
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

  // 截取当前视频帧作为底图
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
  ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

  // 装饰文字
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(20, 20, 320, 60);
  ctx.fillStyle = "white";
  ctx.font = "24px Arial";
  ctx.fillText("LIVE SNAPSHOT: " + new Date().toLocaleTimeString().split(' ')[0], 40, 58);

  snapshotTexture.update();
  updatePreviewFromTexture();
  
  // 关键：截图成功后，把面板“召唤”到你现在看的地方
  placePanelAtCurrentView();
  
  setStatus("Snapshot Captured!");
}

// ---------- 核心：画笔逻辑 (去模式化，即碰即画) ----------
function setupPointerLogic() {
  scene.onPointerObservable.add((pointerInfo) => {
    const type = pointerInfo.type;
    // 检测是否碰到了 Snapshot 面板
    const isHit = pointerInfo.pickInfo && pointerInfo.pickInfo.hit && pointerInfo.pickInfo.pickedMesh === snapshotPanel;
    const uv = isHit ? pointerInfo.pickInfo.getTextureCoordinates() : null;

    if (type === BABYLON.PointerEventTypes.POINTERDOWN) {
      if (uv) {
        isDrawing = true;
        lastDrawUV = uv;
        drawAtUV(uv, true); // 画起始点
      }
    } else if (type === BABYLON.PointerEventTypes.POINTERMOVE) {
      if (!isDrawing) return;
      if (uv) {
        drawAtUV(uv, false); // 连线
        lastDrawUV = uv;
      } else {
        lastDrawUV = null; // 离开面板表面
      }
    } else if (type === BABYLON.PointerEventTypes.POINTERUP) {
      isDrawing = false;
      lastDrawUV = null;
    }
  });
}

function drawAtUV(uv, isFirstPoint) {
  const x = uv.x * PANEL_TEX_WIDTH;
  const y = (1 - uv.y) * PANEL_TEX_HEIGHT;
  const ctx = snapshotTextureCtx;

  ctx.strokeStyle = "#ff3b30"; // 红色画笔
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (isFirstPoint || !lastDrawUV) {
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ff3b30";
    ctx.fill();
  } else {
    const prevX = lastDrawUV.x * PANEL_TEX_WIDTH;
    const prevY = (1 - lastDrawUV.y) * PANEL_TEX_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(prevX, prevY);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  snapshotTexture.update();
  updatePreviewFromTexture();
}

// ---------- 摄像头启动 ----------
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: 1280, height: 720 },
      audio: false
    });
    currentCameraStream = stream;
    video.srcObject = stream;
    await video.play();
    setStatus("Camera Active");
  } catch (err) {
    // 降级尝试
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    await video.play();
  }
}

// ---------- WebXR & 手势检测 ----------
async function initXR() {
  xrHelper = await scene.createDefaultXRExperienceAsync({
    uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
  });

  xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", { xrInput: xrHelper.input });

  xrHelper.input.onControllerAddedObservable.add((input) => {
    if (input.inputSource.hand) {
      if (input.inputSource.handedness === "left") leftHandInput = input;
      else rightHandInput = input;
    }
  });
  
  xrHelper.baseExperience.onStateChangedObservable.add((state) => {
    if (state === BABYLON.WebXRState.IN_XR) placePanelAtCurrentView();
  });
}

function getJointPos(hand, name) {
  if (!hand || !hand.inputSource || !hand.inputSource.hand) return null;
  const joint = hand.inputSource.hand.get(name);
  if (!joint) return null;
  const frame = xrHelper.baseExperience.sessionManager.currentFrame;
  const ref = xrHelper.baseExperience.sessionManager.referenceSpace;
  if (!frame || !ref) return null;
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

// ---------- 主循环逻辑 ----------
function updateLoop() {
  if (!xrHelper) return;

  // 1. Pinch 截图检测 (使用右手)
  const isPinching = detectPinch(rightHandInput);
  if (isPinching && !wasPinchingRight) {
    const now = nowMs();
    if (now - lastPinchTime > pinchCooldownMs) {
      lastPinchTime = now;
      updateSnapshotFromCurrentVideoFrame();
    }
  }
  wasPinchingRight = isPinching;

  // 2. 抓取移动面板 (仅在不画画时生效)
  if (!isDrawing) {
    const rFist = detectFist(rightHandInput);
    if (isGrabbing) {
      const wrist = getJointPos(rightHandInput, "wrist");
      if (!rFist || !wrist) {
        isGrabbing = false;
      } else {
        snapshotPanel.position.copyFrom(wrist);
        const pose = getCameraPoseVectors();
        if (pose) snapshotPanel.lookAt(pose.camPos);
      }
    } else if (rFist) {
      const wrist = getJointPos(rightHandInput, "wrist");
      if (wrist && BABYLON.Vector3.Distance(wrist, snapshotPanel.position) < 0.2) {
        isGrabbing = true;
      }
    }
  }
}

// ---------- 启动 ----------
async function bootstrap() {
  engine = new BABYLON.Engine(canvas, true);
  
  // 场景创建
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
  const camera = new BABYLON.UniversalCamera("camera", new BABYLON.Vector3(0, 1.6, -2), scene);
  const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

  // 面板初始化
  snapshotPanel = BABYLON.MeshBuilder.CreatePlane("snapshotPanel", { width: PANEL_WORLD_WIDTH, height: PANEL_WORLD_HEIGHT, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
  snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT }, scene);
  snapshotTexture.vScale = -1;//镜面反转
  snapshotTextureCtx = snapshotTexture.getContext();
  const mat = new BABYLON.StandardMaterial("sMat", scene);
  mat.diffuseTexture = snapshotTexture;
  mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
  snapshotPanel.material = mat;
  snapshotPanel.setEnabled(false);

  // 运行
  setupPointerLogic();
  await startCamera();
  await initXR();

  engine.runRenderLoop(() => {
    updateLoop();
    scene.render();
  });
  
  window.addEventListener("resize", () => engine.resize());
}

bootstrap();