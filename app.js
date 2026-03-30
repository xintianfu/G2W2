const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

const snapshotPreview = document.getElementById("snapshotPreview");
const previewCtx = snapshotPreview.getContext("2d");
snapshotPreview.width = 512;
snapshotPreview.height = 512;

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

let isDrawing = false;
let lastDrawUV = null;

let currentCameraStream = null;
let leftHandInput = null;
let rightHandInput = null;
const pinchThreshold = 0.04;
const pinchCooldownMs = 1200; // 稍微增长冷却，防止连续保存
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

// 保存截图到设备本地
function saveSnapshotToLocal() {
    try {
        const canvasToSave = snapshotTexture.getContext().canvas;
        // 使用 JPEG 格式减小体积，防止 Quest 浏览器处理超大 Base64 时卡死
        const dataURL = canvasToSave.toDataURL("image/jpeg", 0.9);
        
        const link = document.createElement("a");
        link.href = dataURL;
        link.download = `Quest_AR_Shot_${Date.now()}.jpg`;
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        setStatus("Saved to Downloads!");
    } catch (e) {
        console.error("Save error:", e);
        setStatus("Save Failed: Permissions?");
    }
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
    return { camPos, forward, right };
}

function placePanelAtCurrentView() {
    const data = getCameraPoseVectors();
    if (!data || !snapshotPanel) return;
    const { camPos, forward, right } = data;
    // 放在视野正前方 0.6m
    const targetPos = camPos.add(forward.scale(0.6)).add(right.scale(0.1));
    snapshotPanel.position.copyFrom(targetPos);
    snapshotPanel.lookAt(camPos);
    snapshotPanel.setEnabled(true);
}

// ---------- 核心：修复条状问题的截图逻辑 ----------
function updateSnapshotFromCurrentVideoFrame() {
    // 关键点：如果视频宽度太小，说明流未稳定，不执行绘制
    if (!video.videoWidth || video.videoWidth < 100) {
        setStatus("Camera stream initializing...");
        return;
    }

    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

    // 严谨计算比例，防止条状拉伸
    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const videoAspect = vW / vH;
    const texAspect = PANEL_TEX_WIDTH / PANEL_TEX_HEIGHT;

    let drawWidth, drawHeight, offsetX, offsetY;

    if (videoAspect > texAspect) {
        // 视频比画布更宽
        drawHeight = PANEL_TEX_HEIGHT;
        drawWidth = drawHeight * videoAspect;
        offsetX = (PANEL_TEX_WIDTH - drawWidth) / 2;
        offsetY = 0;
    } else {
        // 视频比画布更高（或相等）
        drawWidth = PANEL_TEX_WIDTH;
        drawHeight = drawWidth / videoAspect;
        offsetX = 0;
        offsetY = (PANEL_TEX_HEIGHT - drawHeight) / 2;
    }

    ctx.save();
    // 镜像修正：中心翻转
    ctx.translate(PANEL_TEX_WIDTH / 2, PANEL_TEX_HEIGHT / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_WIDTH / 2, -PANEL_TEX_HEIGHT / 2);
    
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
    
    // 绘制当前相机帧
    ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
    ctx.restore();

    snapshotTexture.update();
    updatePreviewFromTexture();
    placePanelAtCurrentView();

    // 截图后自动下载到本地
    saveSnapshotToLocal();
}

// ---------- 画笔逻辑 ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        const type = pointerInfo.type;
        const isHit = pointerInfo.pickInfo?.hit && pointerInfo.pickInfo.pickedMesh === snapshotPanel;
        const uv = isHit ? pointerInfo.pickInfo.getTextureCoordinates() : null;

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

// ---------- 硬件启动 ----------
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: 1280, height: 720 },
            audio: false
        });
        video.srcObject = stream;
        await video.play();
        setStatus("Camera ready");
    } catch (err) { setStatus("Camera error: check permissions"); }
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

function getJointPos(hand, name) {
    if (!hand?.inputSource?.hand) return null;
    const joint = hand.inputSource.hand.get(name);
    const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
    const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
    if (!frame || !joint || !ref) return null;
    const pose = frame.getJointPose(joint, ref);
    return pose ? new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z) : null;
}

function updateLoop() {
    if (!xrHelper) return;
    const thumb = getJointPos(rightHandInput, "thumb-tip");
    const index = getJointPos(rightHandInput, "index-finger-tip");
    let isPinching = (thumb && index) ? BABYLON.Vector3.Distance(thumb, index) < pinchThreshold : false;

    if (isPinching && !wasPinchingRight) {
        if (nowMs() - lastPinchTime > pinchCooldownMs) {
            lastPinchTime = nowMs();
            updateSnapshotFromCurrentVideoFrame();
        }
    }
    wasPinchingRight = isPinching;
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
    
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