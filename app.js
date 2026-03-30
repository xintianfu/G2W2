import * as THREE from "three";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";

const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");
const snapshotPreview = document.getElementById("snapshotPreview");
const enterARBtn = document.getElementById("enterARBtn");

const previewCtx = snapshotPreview.getContext("2d");
snapshotPreview.width = 512;
snapshotPreview.height = 512;

let scene, camera, renderer;
let panelMesh, panelMaterial, panelTexture;
let panelCanvas, panelCtx;

let leftHand = null;
let rightHand = null;

let leftPinchMarker = null;
let rightPinchMarker = null;

let isGrabbing = false;
let grabOffset = new THREE.Vector3();

let wasPinchingLeft = false;
let wasPinchingRight = false;
let lastPinchTime = 0;

const pinchThreshold = 0.03;        // 3cm
const grabDistanceThreshold = 0.12; // 12cm
const pinchCooldownMs = 1200;

const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

const tmpThumb = new THREE.Vector3();
const tmpIndex = new THREE.Vector3();
const tmpMid = new THREE.Vector3();
const tmpPanelPos = new THREE.Vector3();
const tmpCamPos = new THREE.Vector3();

function setStatus(text) {
  statusEl.textContent = `状态：${text}`;
  console.log(text);
}

function nowMs() {
  return performance.now();
}

function updatePreviewFromPanelCanvas() {
  previewCtx.clearRect(0, 0, 512, 512);
  previewCtx.drawImage(panelCanvas, 0, 0, 512, 512);
}

function saveSnapshotToLocal() {
  try {
    const dataURL = panelCanvas.toDataURL("image/jpeg", 0.92);
    const link = document.createElement("a");
    link.href = dataURL;
    link.download = `Quest_Shot_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setStatus("已保存截图");
  } catch (e) {
    console.error(e);
    setStatus("保存失败");
  }
}

function getCameraPose() {
  if (!camera) return null;

  const camPos = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, -1);

  camera.getWorldPosition(camPos);
  forward.applyQuaternion(camera.quaternion).normalize();

  return { camPos, forward };
}

function placePanelAtCurrentView() {
  const data = getCameraPose();
  if (!data || !panelMesh) return;

  const targetPos = data.camPos.clone().add(data.forward.multiplyScalar(0.65));
  panelMesh.position.copy(targetPos);
  panelMesh.lookAt(data.camPos);
  panelMesh.visible = true;

  setStatus("面板已生成");
}

function updateSnapshotFromCurrentVideoFrame() {
  if (!video.videoWidth || video.videoWidth < 100) {
    setStatus("摄像头还没准备好");
    return;
  }

  panelCtx.setTransform(1, 0, 0, 1, 0, 0);
  panelCtx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

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

  panelCtx.save();
  panelCtx.translate(PANEL_TEX_WIDTH / 2, PANEL_TEX_HEIGHT / 2);
  panelCtx.scale(-1, 1);
  panelCtx.translate(-PANEL_TEX_WIDTH / 2, -PANEL_TEX_HEIGHT / 2);
  panelCtx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
  panelCtx.restore();

  panelTexture.needsUpdate = true;
  updatePreviewFromPanelCanvas();
  placePanelAtCurrentView();
  saveSnapshotToLocal();
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: 1280,
        height: 720
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    setStatus("摄像头已启动");
  } catch (e) {
    console.error(e);
    setStatus("摄像头启动失败");
  }
}

function createMarker(color = 0xff0000) {
  const geometry = new THREE.SphereGeometry(0.012, 16, 16);
  const material = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}

function getJointWorldPosition(hand, jointName, outVec) {
  if (!hand || !hand.joints) return false;

  const joint = hand.joints[jointName];
  if (!joint) return false;
  if (!joint.visible) return false;

  joint.getWorldPosition(outVec);
  return true;
}

function getPinchState(hand, markerMesh = null) {
  const okThumb = getJointWorldPosition(hand, "thumb-tip", tmpThumb);
  const okIndex = getJointWorldPosition(hand, "index-finger-tip", tmpIndex);

  if (!okThumb || !okIndex) {
    if (markerMesh) markerMesh.visible = false;
    return {
      valid: false,
      pinching: false,
      pinchPoint: null,
      distance: Infinity
    };
  }

  const pinchPoint = tmpMid.copy(tmpThumb).add(tmpIndex).multiplyScalar(0.5);
  const distance = tmpThumb.distanceTo(tmpIndex);

  if (markerMesh) {
    markerMesh.position.copy(pinchPoint);
    markerMesh.visible = true;
  }

  return {
    valid: true,
    pinching: distance < pinchThreshold,
    pinchPoint: pinchPoint.clone(),
    distance
  };
}

function orientPanelTowardCamera() {
  if (!panelMesh || !camera) return;
  camera.getWorldPosition(tmpCamPos);
  panelMesh.lookAt(tmpCamPos);
}

function updateLeftHandLogic() {
  const leftState = getPinchState(leftHand, leftPinchMarker);

  if (
    leftState.valid &&
    leftState.pinching &&
    !wasPinchingLeft &&
    panelMesh.visible
  ) {
    panelMesh.getWorldPosition(tmpPanelPos);
    const distToPanel = leftState.pinchPoint.distanceTo(tmpPanelPos);

    console.log("Left pinch start, distToPanel =", distToPanel);

    if (distToPanel < grabDistanceThreshold) {
      isGrabbing = true;
      grabOffset.copy(tmpPanelPos).sub(leftState.pinchPoint);
      setStatus("左手抓取中");
    } else {
      setStatus(`左手 pinch 了，但离面板太远: ${distToPanel.toFixed(3)}m`);
    }
  }

  if (isGrabbing) {
    if (!leftState.valid || !leftState.pinching) {
      isGrabbing = false;
      grabOffset.set(0, 0, 0);
      setStatus("已松开面板");
    } else {
      panelMesh.position.copy(leftState.pinchPoint).add(grabOffset);
      orientPanelTowardCamera();
    }
  }

  wasPinchingLeft = !!(leftState.valid && leftState.pinching);
}

function updateRightHandLogic() {
  const rightState = getPinchState(rightHand, rightPinchMarker);

  if (rightState.valid && rightState.pinching && !wasPinchingRight) {
    console.log("Right pinch detected");

    if (nowMs() - lastPinchTime > pinchCooldownMs) {
      lastPinchTime = nowMs();
      setStatus("右手 pinch：截图");
      updateSnapshotFromCurrentVideoFrame();
    }
  }

  wasPinchingRight = !!(rightState.valid && rightState.pinching);
}

function updateHandsLogic() {
  if (!renderer.xr.isPresenting) return;

  updateLeftHandLogic();
  updateRightHandLogic();
}

function initHands() {
  const handModelFactory = new XRHandModelFactory();

  const hand0 = renderer.xr.getHand(0);
  const hand1 = renderer.xr.getHand(1);

  hand0.add(handModelFactory.createHandModel(hand0, "mesh"));
  hand1.add(handModelFactory.createHandModel(hand1, "mesh"));

  scene.add(hand0);
  scene.add(hand1);

  hand0.addEventListener("connected", (event) => {
    const handedness = event.data?.handedness;
    console.log("hand0 connected:", handedness);

    if (handedness === "left") {
      leftHand = hand0;
      setStatus("检测到左手");
    } else if (handedness === "right") {
      rightHand = hand0;
      setStatus("检测到右手");
    }
  });

  hand1.addEventListener("connected", (event) => {
    const handedness = event.data?.handedness;
    console.log("hand1 connected:", handedness);

    if (handedness === "left") {
      leftHand = hand1;
      setStatus("检测到左手");
    } else if (handedness === "right") {
      rightHand = hand1;
      setStatus("检测到右手");
    }
  });

  hand0.addEventListener("disconnected", () => {
    if (leftHand === hand0) {
      leftHand = null;
      isGrabbing = false;
      wasPinchingLeft = false;
      if (leftPinchMarker) leftPinchMarker.visible = false;
      setStatus("左手断开");
    }

    if (rightHand === hand0) {
      rightHand = null;
      wasPinchingRight = false;
      if (rightPinchMarker) rightPinchMarker.visible = false;
      setStatus("右手断开");
    }
  });

  hand1.addEventListener("disconnected", () => {
    if (leftHand === hand1) {
      leftHand = null;
      isGrabbing = false;
      wasPinchingLeft = false;
      if (leftPinchMarker) leftPinchMarker.visible = false;
      setStatus("左手断开");
    }

    if (rightHand === hand1) {
      rightHand = null;
      wasPinchingRight = false;
      if (rightPinchMarker) rightPinchMarker.visible = false;
      setStatus("右手断开");
    }
  });
}

function initScene() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    20
  );

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true
  });

  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
  light.position.set(0, 1, 0);
  scene.add(light);

  panelCanvas = document.createElement("canvas");
  panelCanvas.width = PANEL_TEX_WIDTH;
  panelCanvas.height = PANEL_TEX_HEIGHT;
  panelCtx = panelCanvas.getContext("2d");

  panelCtx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

  panelTexture = new THREE.CanvasTexture(panelCanvas);
  panelTexture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(
    PANEL_WORLD_WIDTH,
    PANEL_WORLD_HEIGHT
  );

  panelMaterial = new THREE.MeshBasicMaterial({
    map: panelTexture,
    transparent: true,
    side: THREE.DoubleSide
  });

  panelMesh = new THREE.Mesh(geometry, panelMaterial);
  panelMesh.visible = false;
  scene.add(panelMesh);

  leftPinchMarker = createMarker(0x00ff00);
  rightPinchMarker = createMarker(0xff0000);

  initHands();

  window.addEventListener("resize", onWindowResize);
}

async function setupManualARButton() {
  if (!enterARBtn) {
    setStatus("缺少 #enterARBtn 按钮");
    return;
  }

  if (!navigator.xr) {
    setStatus("当前浏览器不支持 WebXR");
    enterARBtn.disabled = true;
    return;
  }

  try {
    const supported = await navigator.xr.isSessionSupported("immersive-ar");

    if (!supported) {
      setStatus("当前环境不支持 immersive-ar");
      enterARBtn.disabled = true;
      return;
    }

    setStatus("支持 immersive-ar，点击按钮进入");
    enterARBtn.disabled = false;

    enterARBtn.addEventListener("click", async () => {
      try {
        setStatus("正在请求 AR 会话...");

        const session = await navigator.xr.requestSession("immersive-ar", {
          requiredFeatures: ["hand-tracking"],
          optionalFeatures: ["local-floor"]
        });

        await renderer.xr.setSession(session);

        setStatus("已进入 AR");
        enterARBtn.style.display = "none";

        session.addEventListener("end", () => {
          setStatus("AR 已退出");
          enterARBtn.style.display = "block";
          isGrabbing = false;
          wasPinchingLeft = false;
          wasPinchingRight = false;

          if (leftPinchMarker) leftPinchMarker.visible = false;
          if (rightPinchMarker) rightPinchMarker.visible = false;
        });
      } catch (e) {
        console.error(e);
        setStatus("进入 AR 失败: " + e.message);
      }
    }, { once: false });

  } catch (e) {
    console.error(e);
    setStatus("AR 支持检测失败: " + e.message);
    enterARBtn.disabled = true;
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function bootstrap() {
  try {
    initScene();
    await setupManualARButton();
    await startCamera();

    renderer.setAnimationLoop(() => {
      updateHandsLogic();
      renderer.render(scene, camera);
    });

    setStatus("初始化完成，等待进入 AR");
  } catch (e) {
    console.error(e);
    setStatus("初始化失败: " + e.message);
  }
}

bootstrap();