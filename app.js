const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

const snapshotPreview = document.getElementById("snapshotPreview");
const previewCtx = snapshotPreview.getContext("2d");
snapshotPreview.width = 512;
snapshotPreview.height = 512;

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// 交互状态
let isDrawing = false;
let isGrabbing = false;
let currentGrabHand = null; // "left" | "right"
let lastDrawUV = null;

let currentCameraStream = null;
let leftHandInput = null;
let rightHandInput = null;

// 阈值配置
const pinchThreshold = 0.04;
const pinchCooldownMs = 1000;
const grabDistanceThreshold = 0.25; // 手部离面板多近可以抓取
const fistThreshold = 0.08;        // 判定为握拳的平均距离阈值

let lastPinchTime = 0;
let wasPinchingRight = false;

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
    if (!snapshotTexture) return;
    previewCtx.clearRect(0, 0, 512, 512);
    previewCtx.drawImage(snapshotTexture.getContext().canvas, 0, 0, 512, 512);
}

function getCameraPoseVectors() {
    let cam = (xrHelper?.baseExperience?.state === BABYLON.WebXRState.IN_XR) 
        ? xrHelper.baseExperience.camera 
        : scene.activeCamera;
    if (!cam) return null;
    const camPos = cam.globalPosition ? cam.globalPosition.clone() : cam.position.clone();
    const forward = cam.getForwardRay(1).direction.normalize();
    const up = new BABYLON.Vector3(0, 1, 0);
    const right = BABYLON.Vector3.Cross(forward, up).normalize();
    return { cam, camPos, forward, up, right };
}

function placePanelAtCurrentView() {
    const data = getCameraPoseVectors();
    if (!data || !snapshotPanel) return;
    const { camPos, forward, right } = data;
    const targetPos = camPos.add(forward.scale(0.6)).add(right.scale(0.1));
    snapshotPanel.position.copyFrom(targetPos);
    snapshotPanel.lookAt(camPos);
    snapshotPanel.setEnabled(true);
}

// ---------- 截图逻辑 ----------
function updateSnapshotFromCurrentVideoFrame() {
    if (!video.videoWidth || !video.videoHeight) return;
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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

    ctx.save();
    ctx.translate(PANEL_TEX_WIDTH / 2, PANEL_TEX_HEIGHT / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_WIDTH / 2, -PANEL_TEX_HEIGHT / 2);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
    ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
    ctx.restore();

    snapshotTexture.update();
    updatePreviewFromTexture();
    placePanelAtCurrentView();
}

// ---------- 画笔逻辑 ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        const type = pointerInfo.type;
        const pickInfo = pointerInfo.pickInfo;
        const isHit = pickInfo?.hit && pickInfo.pickedMesh === snapshotPanel;
        const uv = isHit ? pickInfo.getTextureCoordinates() : null;

        if (type === BABYLON.PointerEventTypes.POINTERDOWN && uv) {
            isDrawing = true;
            lastDrawUV = uv;
            drawAtUV(uv, true);
        } else if (type === BABYLON.PointerEventTypes.POINTERMOVE && isDrawing) {
            if (uv) {
                drawAtUV(uv, false);
                lastDrawUV = uv;
            } else {
                lastDrawUV = null;
            }
        } else if (type === BABYLON.PointerEventTypes.POINTERUP) {
            isDrawing = false;
            lastDrawUV = null;
        }
    });
}

function drawAtUV(uv, isFirstPoint) {
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); 
    const x = (1 - uv.x) * PANEL_TEX_WIDTH;
    const y = (1 - uv.y) * PANEL_TEX_HEIGHT; 
    
    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (isFirstPoint || !lastDrawUV) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ff3b30";
        ctx.fill();
    } else {
        const prevX = (1 - lastDrawUV.x) * PANEL_TEX_WIDTH;
        const prevY = (1 - lastDrawUV.y) * PANEL_TEX_HEIGHT;
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(x, y);
        ctx.stroke();
    }
    snapshotTexture.update();
    updatePreviewFromTexture();
}

// ---------- 手势检测逻辑 ----------
function getJointPos(hand, name) {
    if (!hand?.inputSource?.hand) return null;
    const joint = hand.inputSource.hand.get(name);
    const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
    const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
    if (!frame || !joint || !ref) return null;
    const pose = frame.getJointPose(joint, ref);
    return pose ? new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z) : null;
}

// 检测握拳手势
function detectFist(handInput) {
    const wrist = getJointPos(handInput, "wrist");
    const indexTip = getJointPos(handInput, "index-finger-tip");
    const middleTip = getJointPos(handInput, "middle-finger-tip");
    const ringTip = getJointPos(handInput, "ring-finger-tip");

    if (!wrist || !indexTip || !middleTip || !ringTip) return false;

    // 计算指尖到手腕的平均距离
    const avgDist = (
        BABYLON.Vector3.Distance(wrist, indexTip) +
        BABYLON.Vector3.Distance(wrist, middleTip) +
        BABYLON.Vector3.Distance(wrist, ringTip)
    ) / 3;

    return avgDist < fistThreshold;
}

// ---------- 核心循环 ----------
function updateLoop() {
    if (!xrHelper) return;

    // 1. Pinch 截图逻辑 (右手)
    const rightThumb = getJointPos(rightHandInput, "thumb-tip");
    const rightIndex = getJointPos(rightHandInput, "index-finger-tip");
    let isPinching = (rightThumb && rightIndex) ? BABYLON.Vector3.Distance(rightThumb, rightIndex) < pinchThreshold : false;

    if (isPinching && !wasPinchingRight) {
        if (nowMs() - lastPinchTime > pinchCooldownMs) {
            lastPinchTime = nowMs();
            updateSnapshotFromCurrentVideoFrame();
        }
    }
    wasPinchingRight = isPinching;

    // 2. 握拳抓取移动逻辑
    handleGrabbing();
}

function handleGrabbing() {
    const leftFist = detectFist(leftHandInput);
    const rightFist = detectFist(rightHandInput);

    if (isGrabbing) {
        // 正在抓取中
        const activeHand = currentGrabHand === "left" ? leftHandInput : rightHandInput;
        const stillFist = currentGrabHand === "left" ? leftFist : rightFist;
        const wristPos = getJointPos(activeHand, "wrist");

        // 如果松开拳头或丢失追踪，停止抓取
        if (!stillFist || !wristPos) {
            isGrabbing = false;
            currentGrabHand = null;
            setStatus("Grab Released");
            return;
        }

        // 面板跟随手腕移动
        snapshotPanel.position.copyFrom(wristPos);
        
        // 让面板始终朝向相机
        const data = getCameraPoseVectors();
        if (data) snapshotPanel.lookAt(data.camPos);

    } else {
        // 检测起始抓取条件
        if (leftFist) {
            checkAndStartGrab(leftHandInput, "left");
        } else if (rightFist) {
            checkAndStartGrab(rightHandInput, "right");
        }
    }
}

function checkAndStartGrab(handInput, side) {
    const wristPos = getJointPos(handInput, "wrist");
    if (!wristPos || !snapshotPanel) return;

    // 检查手部是否离面板足够近
    const dist = BABYLON.Vector3.Distance(wristPos, snapshotPanel.position);
    if (dist < grabDistanceThreshold) {
        isGrabbing = true;
        currentGrabHand = side;
        setStatus(`Grabbing with ${side} hand`);
    }
}

// ---------- 启动 ----------
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: 1280, height: 720 },
            audio: false
        });
        video.srcObject = stream;
        await video.play();
    } catch (err) { setStatus("Camera Error"); }
}

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
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
    
    // 初始化面板
    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("snapshotPanel", { width: PANEL_WORLD_WIDTH, height: PANEL_WORLD_HEIGHT, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT }, scene);
    snapshotTextureCtx = snapshotTexture.getContext();
    
    const mat = new BABYLON.StandardMaterial("sMat", scene);
    mat.diffuseTexture = snapshotTexture;
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    mat.disableLighting = true;
    snapshotPanel.material = mat;
    snapshotPanel.setEnabled(false);

    setupPointerLogic();
    startCamera();
    await initXR();

    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });
}

bootstrap();