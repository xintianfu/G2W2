const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

const snapshotPreview = document.getElementById("snapshotPreview");
const previewCtx = snapshotPreview.getContext("2d");
snapshotPreview.width = 512;
snapshotPreview.height = 512;

import * as THREE from "three";
import { ARButton } from "three/addons/webxr/ARButton.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";

let scene, camera, renderer;
let panelMesh, panelMaterial, panelTexture;
let panelCanvas, panelCtx;

let leftHand = null;
let rightHand = null;

let isGrabbing = false;
let grabOffset = new THREE.Vector3();

let wasPinchingLeft = false;
let wasPinchingRight = false;
let lastPinchTime = 0;

const pinchThreshold = 0.03;        // 3cm
const grabDistanceThreshold = 0.10; // 10cm
const pinchCooldownMs = 1200;

const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

const tmpVecA = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();
const tmpVecC = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
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
    const dataURL = panelCanvas.toDataURL("image/jpeg", 0.9);
    const link = document.createElement("a");
    link.href = dataURL;
    link.download = `Quest_Shot_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setStatus("Saved!");
  } catch (e) {
    console.error(e);
    setStatus("Save Failed");
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

  const targetPos = data.camPos.clone().add(data.forward.multiplyScalar(0.6));
  panelMesh.position.copy(targetPos);
  panelMesh.lookAt(data.camPos);
  panelMesh.visible = true;
}

function updateSnapshotFromCurrentVideoFrame() {
  if (!video.videoWidth || video.videoWidth < 100) return;

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

  // 镜像绘制
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
    setStatus("Camera OK");
  } catch (e) {
    console.error(e);
    setStatus("Camera Error");
  }
}

function getJointWorldPosition(hand, jointName, outVec) {
  if (!hand) return false;

  const joint = hand.joints[jointName];
  if (!joint || !joint.visible) return false;

  joint.getWorldPosition(outVec);
  return true;
}

function getPinchState(hand, outPinchPoint) {
  const okThumb = getJointWorldPosition(hand, "thumb-tip", tmpVecA);
  const okIndex = getJointWorldPosition(hand, "index-finger-tip", tmpVecB);

  if (!okThumb || !okIndex) return { valid: false, pinching: false };

  const dist = tmpVecA.distanceTo(tmpVecB);
  outPinchPoint.copy(tmpVecA).add(tmpVecB).multiplyScalar(0.5);

  return {
    valid: true,
    pinching: dist < pinchThreshold,
    distance: dist
  };
}

function orientPanelTowardCamera() {
  if (!panelMesh || !camera) return;
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  panelMesh.lookAt(camPos);
}

function updateHandsLogic() {
  if (!renderer.xr.isPresenting) return;

  // ---------- 左手 ----------
  const leftPinchPoint = new THREE.Vector3();
  const leftState = getPinchState(leftHand, leftPinchPoint);

  if (
    leftState.valid &&
    leftState.pinching &&
    !wasPinchingLeft &&
    panelMesh.visible
  ) {
    const panelPos = new THREE.Vector3();
    panelMesh.getWorldPosition(panelPos);

    const distToPanel = leftPinchPoint.distanceTo(panelPos);

    if (distToPanel < grabDistanceThreshold) {
      isGrabbing = true;
      grabOffset.copy(panelPos).sub(leftPinchPoint);
      setStatus("Grabbing (Left)");
    }
  }

  if (isGrabbing) {
    if (!leftState.valid || !leftState.pinching) {
      isGrabbing = false;
      grabOffset.set(0, 0, 0);
      setStatus("Ready");
    } else {
      panelMesh.position.copy(leftPinchPoint).add(grabOffset);
      orientPanelTowardCamera();
    }
  }

  wasPinchingLeft = !!(leftState.valid && leftState.pinching);

  // ---------- 右手 ----------
  const rightPinchPoint = new THREE.Vector3();
  const rightState = getPinchState(rightHand, rightPinchPoint);

  if (rightState.valid && rightState.pinching && !wasPinchingRight) {
    if (nowMs() - lastPinchTime > pinchCooldownMs) {
      lastPinchTime = nowMs();
      updateSnapshotFromCurrentVideoFrame();
    }
  }

  wasPinchingRight = !!(rightState.valid && rightState.pinching);
}

function initScene() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

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

  // panel texture canvas
  panelCanvas = document.createElement("canvas");
  panelCanvas.width = PANEL_TEX_WIDTH;
  panelCanvas.height = PANEL_TEX_HEIGHT;
  panelCtx = panelCanvas.getContext("2d");
  panelCtx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

  panelTexture = new THREE.CanvasTexture(panelCanvas);
  panelTexture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(PANEL_WORLD_WIDTH, PANEL_WORLD_HEIGHT);
  panelMaterial = new THREE.MeshBasicMaterial({
    map: panelTexture,
    transparent: true,
    side: THREE.DoubleSide
  });

  panelMesh = new THREE.Mesh(geometry, panelMaterial);
  panelMesh.visible = false;
  scene.add(panelMesh);

  // hands
  const handModelFactory = new XRHandModelFactory();

  leftHand = renderer.xr.getHand(0);
  rightHand = renderer.xr.getHand(1);

  leftHand.add(handModelFactory.createHandModel(leftHand, "mesh"));
  rightHand.add(handModelFactory.createHandModel(rightHand, "mesh"));

  scene.add(leftHand);
  scene.add(rightHand);

  // connected debug
  leftHand.addEventListener("connected", (e) => {
    console.log("Left hand connected", e.data);
  });
  rightHand.addEventListener("connected", (e) => {
    console.log("Right hand connected", e.data);
  });

  leftHand.addEventListener("disconnected", () => {
    isGrabbing = false;
    wasPinchingLeft = false;
    setStatus("Left hand disconnected");
  });

  rightHand.addEventListener("disconnected", () => {
    wasPinchingRight = false;
    setStatus("Right hand disconnected");
  });

  // AR button
  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ["hand-tracking"],
      optionalFeatures: ["local-floor"]
    })
  );

  window.addEventListener("resize", onWindowResize);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function bootstrap() {
  initScene();
  await startCamera();

  renderer.setAnimationLoop(() => {
    updateHandsLogic();
    renderer.render(scene, camera);
  });

  setStatus("Ready");
}

bootstrap();