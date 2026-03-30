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
let lastDrawUV = null;

let leftHandInput = null;
let rightHandInput = null;

const pinchThreshold = 0.04;
const pinchCooldownMs = 1200;
// 关键改进：增大抓取判定半径，防止捏不到
const grabDistanceThreshold = 0.6; 

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

function saveSnapshotToLocal() {
    try {
        const canvasToSave = snapshotTexture.getContext().canvas;
        const dataURL = canvasToSave.toDataURL("image/jpeg", 0.9);
        const link = document.createElement("a");
        link.href = dataURL;
        link.download = `Quest_Shot_${Date.now()}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setStatus("Saved!");
    } catch (e) { setStatus("Save Failed"); }
}

function getCameraPoseVectors() {
    const cam = (xrHelper?.baseExperience?.state === BABYLON.WebXRState.IN_XR) 
        ? xrHelper.baseExperience.camera 
        : scene.activeCamera;
    if (!cam) return null;
    const camPos = cam.globalPosition ? cam.globalPosition.clone() : cam.position.clone();
    const forward = cam.getForwardRay(1).direction.normalize();
    return { camPos, forward };
}

function placePanelAtCurrentView() {
    const data = getCameraPoseVectors();
    if (!data || !snapshotPanel) return;
    const targetPos = data.camPos.add(data.forward.scale(0.6));
    snapshotPanel.position.copyFrom(targetPos);
    snapshotPanel.lookAt(data.camPos, Math.PI); 
    snapshotPanel.setEnabled(true);
}

// ---------- 截图逻辑 ----------
function updateSnapshotFromCurrentVideoFrame() {
    if (!video.videoWidth || video.videoWidth < 100) return;
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
    ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
    ctx.restore();

    snapshotTexture.update();
    updatePreviewFromTexture();
    placePanelAtCurrentView();
    saveSnapshotToLocal();
}

// ---------- 画笔逻辑 (隔离左手) ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        // XR 模式下屏蔽左手画画
        if (xrHelper && xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
            try {
                const pointerId = pointerInfo.event.pointerId;
                const inputSource = xrHelper.pointerSelection.getPointerContext(pointerId)?.inputSource;
                if (inputSource && inputSource.handedness === "left") return;
            } catch (e) { return; }
        }

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
            } else { lastDrawUV = null; }
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
    if (isFirstPoint || !lastDrawUV) {
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ff3b30"; ctx.fill();
    } else {
        const pX = (1 - lastDrawUV.x) * PANEL_TEX_WIDTH;
        const pY = (1 - lastDrawUV.y) * PANEL_TEX_HEIGHT;
        ctx.beginPath(); ctx.moveTo(pX, pY); ctx.lineTo(x, y); ctx.stroke();
    }
    snapshotTexture.update();
}

// ---------- 手势检测 ----------
function getJointPos(hand, name) {
    if (!hand || !hand.inputSource || !hand.inputSource.hand) return null;
    const joint = hand.inputSource.hand.get(name);
    const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
    const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
    if (!frame || !joint || !ref) return null;
    const pose = frame.getJointPose(joint, ref);
    return pose ? new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z) : null;
}

function getPinchInfo(hand) {
    const t = getJointPos(hand, "thumb-tip");
    const i = getJointPos(hand, "index-finger-tip");
    if (!t || !i) return { isPinching: false, pos: null };
    const dist = BABYLON.Vector3.Distance(t, i);
    return { isPinching: dist < pinchThreshold, pos: BABYLON.Vector3.Center(t, i) };
}

// ---------- 核心循环：左手移动 + 右手截图 ----------
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    // 1. 左手抓取逻辑
    const leftPinch = getPinchInfo(leftHandInput);
    if (isGrabbing) {
        if (!leftPinch.isPinching) {
            isGrabbing = false;
            // 抓取结束，恢复颜色
            snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
            setStatus("Ready");
        } else {
            // 抓取中：吸附位置并面向相机
            snapshotPanel.setAbsolutePosition(leftPinch.pos);
            const camData = getCameraPoseVectors();
            if (camData) snapshotPanel.lookAt(camData.camPos, Math.PI);
        }
    } else if (leftPinch.isPinching) {
        // 判定：左手捏合点离面板中心是否足够近
        const dist = BABYLON.Vector3.Distance(leftPinch.pos, snapshotPanel.position);
        if (dist < grabDistanceThreshold) {
            isGrabbing = true;
            // 抓取成功视觉反馈：变蓝光
            snapshotMaterial.emissiveColor = new BABYLON.Color3(0.5, 0.7, 1);
            setStatus("Grabbing...");
        }
    }

    // 2. 右手截图逻辑
    const rightPinch = getPinchInfo(rightHandInput);
    if (rightPinch.isPinching && !wasPinchingRight) {
        if (nowMs() - lastPinchTime > pinchCooldownMs) {
            lastPinchTime = nowMs();
            updateSnapshotFromCurrentVideoFrame();
        }
    }
    wasPinchingRight = rightPinch.isPinching;
}

// ---------- 启动程序 ----------
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: 1280, height: 720 },
            audio: false
        });
        video.srcObject = stream;
        await video.play();
        setStatus("Camera OK");
    } catch (e) { setStatus("Camera Error"); }
}

async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        
        xrHelper.input.onControllerAddedObservable.add((input) => {
            if (input.inputSource.hand) {
                const side = input.inputSource.handedness;
                if (side === "left") leftHandInput = input;
                else if (side === "right") rightHandInput = input;
            }
        });

        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", { xrInput: xrHelper.input });
        setStatus("XR Ready.");
    } catch (e) { setStatus("XR error: " + e.message); }
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("snapshotPanel", { width: PANEL_WORLD_WIDTH, height: PANEL_WORLD_HEIGHT, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT }, scene);
    snapshotTextureCtx = snapshotTexture.getContext();
    
    snapshotMaterial = new BABYLON.StandardMaterial("sMat", scene);
    snapshotMaterial.diffuseTexture = snapshotTexture;
    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
    snapshotMaterial.disableLighting = true;
    snapshotPanel.material = snapshotMaterial;
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