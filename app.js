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
let isGrabbing = false;
let lastDrawUV = null;

let leftHandInput = null;
let rightHandInput = null;

const pinchThreshold = 0.04; 
const pinchCooldownMs = 1000;
const grabDistanceThreshold = 0.4; // 增大感应范围，确保能捏住

let lastPinchTime = 0;
let wasPinchingRight = false;

const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

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
    return { camPos, forward };
}

function placePanelAtCurrentView() {
    const data = getCameraPoseVectors();
    if (!data || !snapshotPanel) return;
    const targetPos = data.camPos.add(data.forward.scale(0.6));
    snapshotPanel.position.copyFrom(targetPos);
    snapshotPanel.lookAt(data.camPos); 
    snapshotPanel.setEnabled(true);
}

// ---------- 截图逻辑 (简单纯净绘图) ----------
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

    // 正常绘制视频，不在这里翻转
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
    ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

    snapshotTexture.update();
    updatePreviewFromTexture();
    placePanelAtCurrentView();
}

// ---------- 画笔逻辑 (适配镜像) ----------
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
    
    // 因为设置了 uScale = -1，所以 X 轴不需要在计算时 (1-uv.x)
    // 直接使用 uv.x * WIDTH 即可。
    const x = uv.x * PANEL_TEX_WIDTH;
    const y = (1 - uv.y) * PANEL_TEX_HEIGHT; 
    
    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";

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
}

// ---------- 手势逻辑 ----------
function getJointPos(hand, name) {
    if (!hand?.inputSource?.hand) return null;
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
    if (!t || !i) return { pinching: false };
    const dist = BABYLON.Vector3.Distance(t, i);
    return {
        pinching: dist < pinchThreshold,
        point: BABYLON.Vector3.Center(t, i)
    };
}

function updateLoop() {
    if (!xrHelper) return;

    // 1. 左手搬运检测 (改进的范围判定)
    const leftPinch = getPinchInfo(leftHandInput);
    if (isGrabbing) {
        if (!leftPinch.pinching) {
            isGrabbing = false;
            setStatus("Released");
        } else {
            snapshotPanel.setAbsolutePosition(leftPinch.point);
            const data = getCameraPoseVectors();
            if (data) snapshotPanel.lookAt(data.camPos);
        }
    } else if (leftPinch.pinching) {
        const dist = BABYLON.Vector3.Distance(leftPinch.point, snapshotPanel.position);
        if (dist < grabDistanceThreshold) {
            isGrabbing = true;
            setStatus("Grabbed Left");
        }
    }

    // 2. 右手截图检测
    const rightPinch = getPinchInfo(rightHandInput);
    if (rightPinch.pinching && !wasPinchingRight) {
        if (nowMs() - lastPinchTime > pinchCooldownMs) {
            lastPinchTime = nowMs();
            updateSnapshotFromCurrentVideoFrame();
        }
    }
    wasPinchingRight = rightPinch.pinching;
}

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: 1280 },
            audio: false
        });
        video.srcObject = stream;
        await video.play();
    } catch (e) { setStatus("Camera Error"); }
}

async function initXR() {
    try {
        setStatus("Requesting XR...");
        
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: {
                sessionMode: "immersive-ar",
                referenceSpaceType: "local-floor",
                // 确保按钮位置正常
                onError: (error) => setStatus("XR Error: " + error)
            },
            optionalFeatures: true // 必须开启，否则手势追踪无法加载
        });

        if (!xrHelper.baseExperience) {
            throw new Error("XR Not Supported on this device/browser");
        }

        // 启用手势
        const featureManager = xrHelper.baseExperience.featuresManager;
        featureManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });

        // 监听手部加入
        xrHelper.input.onControllerAddedObservable.add((input) => {
            if (input.inputSource.hand) {
                const side = input.inputSource.handedness;
                if (side === "left") leftHandInput = input;
                else if (side === "right") rightHandInput = input;
                console.log(side + " hand detected");
            }
        });

        setStatus("XR Ready. Click AR button.");

    } catch (e) {
        console.error(e);
        setStatus("XR Failed: " + e.message);
    }
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("snapshotPanel", { width: PANEL_WORLD_WIDTH, height: PANEL_WORLD_HEIGHT, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT }, scene);
    
    // --- 镜像终极修复 ---
    snapshotTexture.uScale = -1; // 水平翻转，修正左右镜像
    // --------------------

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