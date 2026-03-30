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
const pinchCooldownMs = 1000;
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
    return { camPos, forward, right };
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

// ---------- 核心修复：截图逻辑 (解决垂直镜像和水平镜像) ----------
function updateSnapshotFromCurrentVideoFrame() {
    if (!video.videoWidth || !video.videoHeight) return;
    const ctx = snapshotTextureCtx;
    
    // 1. 重置变换矩阵并清空画布
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

    // --- 修复镜像核心逻辑 ---
    // 摄像头的默认画面在 Canvas 里是左右反的，且 V 轴坐标也可能反。
    // 我们在这里通过矩阵操作把它调正。
    ctx.save();
    
    // 核心组合变换：
    // 1. 移动原点到画布中心
    ctx.translate(PANEL_TEX_WIDTH / 2, PANEL_TEX_HEIGHT / 2);
    // 2. 左右对称翻转 (-1, 1) 实现镜像修正
    // 如果你发现左右还是反，把这个改为 (1, 1)
    // 如果你发现上下反了，把这个改为 (-1, -1)
    ctx.scale(-1, 1); 
    // 3. 移回左上角
    ctx.translate(-PANEL_TEX_WIDTH / 2, -PANEL_TEX_HEIGHT / 2);
    
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
    ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
    
    ctx.restore();
    // -----------------------

    ctx.fillStyle = "white";
    ctx.font = "bold 28px Arial";
    ctx.fillText("CORRECTED SHOT: " + new Date().toLocaleTimeString(), 40, 60);

    snapshotTexture.update();
    updatePreviewFromTexture();
    placePanelAtCurrentView();
}

// ---------- 画笔逻辑 (同步修正后的坐标) ----------
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
    // 绘图时重置变换矩阵，确保画笔不受截图矩阵影响
    ctx.setTransform(1, 0, 0, 1, 0, 0); 
    
    // 关键点：由于底图在 Canvas 里反着画了修正镜像，
    // 这里计算画笔坐标时也要同步修正 X 轴。
    // 使用 (1 - uv.x)
    const x = (1 - uv.x) * PANEL_TEX_WIDTH;
    
    // Babylon 的 UV 原点在左下，Canvas 绘图原点在左上，需要反转 Y。
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
        // 连线坐标计算也必须一致
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

// ---------- 摄像头与 XR (保持不变) ----------
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: 1280, height: 720 },
            audio: false
        });
        video.srcObject = stream;
        await video.play();
        setStatus("Camera OK");
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
    const cam = new BABYLON.UniversalCamera("camera", new BABYLON.Vector3(0, 1.6, -2), scene);

    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("snapshotPanel", { width: PANEL_WORLD_WIDTH, height: PANEL_WORLD_HEIGHT, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT }, scene);
    
    // 这里依然不使用 vScale = -1，防止 Quest 卡死消失。
    
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