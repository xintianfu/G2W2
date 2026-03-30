const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

const snapshotPreview = document.getElementById("snapshotPreview");
const previewCtx = snapshotPreview.getContext("2d");
snapshotPreview.width = 512;
snapshotPreview.height = 512;

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// ---------- 交互状态 ----------
let isDrawing = false;
let isGrabbing = false;
let lastDrawUV = null;

let leftHandInput = null;
let rightHandInput = null;

let wasPinchingLeft = false;
let wasPinchingRight = false;

let grabOffset = null;

const pinchThreshold = 0.03;          // 左右手 pinch 阈值，3cm 更稳一点
const grabDistanceThreshold = 0.08;   // 左手 pinch 点离 panel 中心 8cm 内可抓取
const pinchCooldownMs = 1200;
let lastPinchTime = 0;

const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

// ---------- 工具函数 ----------
function setStatus(text) {
    statusEl.textContent = `Status: ${text}`;
    console.log(text);
}

function nowMs() {
    return performance.now();
}

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
    } catch (e) {
        console.error(e);
        setStatus("Save Failed");
    }
}

function getCameraPoseVectors() {
    const cam = (xrHelper?.baseExperience?.state === BABYLON.WebXRState.IN_XR)
        ? xrHelper.baseExperience.camera
        : scene.activeCamera;

    if (!cam) return null;

    const camPos = cam.globalPosition
        ? cam.globalPosition.clone()
        : cam.position.clone();

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

// ---------- 画笔逻辑（仅右手） ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        if (xrHelper && xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
            try {
                const pointerId = pointerInfo.event.pointerId;
                const inputSource = xrHelper.pointerSelection.getPointerContext(pointerId)?.inputSource;

                // 屏蔽左手绘画，左手只负责抓取
                if (inputSource && inputSource.handedness === "left") return;
            } catch (e) {
                return;
            }
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

    if (isFirstPoint || !lastDrawUV) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ff3b30";
        ctx.fill();
    } else {
        const pX = (1 - lastDrawUV.x) * PANEL_TEX_WIDTH;
        const pY = (1 - lastDrawUV.y) * PANEL_TEX_HEIGHT;
        ctx.beginPath();
        ctx.moveTo(pX, pY);
        ctx.lineTo(x, y);
        ctx.stroke();
    }

    snapshotTexture.update();
    updatePreviewFromTexture();
}

// ---------- 手势检测辅助 ----------
function getJointPos(hand, name) {
    if (!hand || !hand.inputSource || !hand.inputSource.hand) return null;

    const joint = hand.inputSource.hand.get(name);
    const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
    const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;

    if (!frame || !joint || !ref) return null;

    const pose = frame.getJointPose(joint, ref);
    if (!pose) return null;

    return new BABYLON.Vector3(
        pose.transform.position.x,
        pose.transform.position.y,
        pose.transform.position.z
    );
}

function getPinchPoint(hand) {
    const t = getJointPos(hand, "thumb-tip");
    const i = getJointPos(hand, "index-finger-tip");
    if (!t || !i) return null;
    return BABYLON.Vector3.Center(t, i);
}

// ---------- 核心循环 ----------
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    // ===== 1. 左手抓取 =====
    const lThumb = getJointPos(leftHandInput, "thumb-tip");
    const lIndex = getJointPos(leftHandInput, "index-finger-tip");
    const leftPinchPoint = (lThumb && lIndex) ? BABYLON.Vector3.Center(lThumb, lIndex) : null;
    const isPinchingLeft = (lThumb && lIndex)
        ? BABYLON.Vector3.Distance(lThumb, lIndex) < pinchThreshold
        : false;

    // 左手 pinch 刚开始：判断是否靠近 panel，可以开始抓取
    if (
        isPinchingLeft &&
        !wasPinchingLeft &&
        leftPinchPoint &&
        snapshotPanel &&
        snapshotPanel.isEnabled()
    ) {
        const panelPos = snapshotPanel.getAbsolutePosition();
        const distToPanel = BABYLON.Vector3.Distance(leftPinchPoint, panelPos);

        if (distToPanel < grabDistanceThreshold) {
            isGrabbing = true;
            grabOffset = panelPos.subtract(leftPinchPoint);
            snapshotMaterial.emissiveColor = new BABYLON.Color3(0.5, 0.7, 1);
            setStatus("Grabbing (Left)");
        }
    }

    // 抓取中：panel 跟随左手 pinch 点移动
    if (isGrabbing) {
        if (!isPinchingLeft || !leftPinchPoint) {
            isGrabbing = false;
            grabOffset = null;
            snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
            setStatus("Ready");
        } else {
            const targetPos = leftPinchPoint.add(grabOffset);
            snapshotPanel.setAbsolutePosition(targetPos);

            const camData = getCameraPoseVectors();
            if (camData) {
                snapshotPanel.lookAt(camData.camPos, Math.PI);
            }
        }
    }

    wasPinchingLeft = isPinchingLeft;

    // ===== 2. 右手截图 =====
    const rThumb = getJointPos(rightHandInput, "thumb-tip");
    const rIndex = getJointPos(rightHandInput, "index-finger-tip");
    const isPinchingRight = (rThumb && rIndex)
        ? BABYLON.Vector3.Distance(rThumb, rIndex) < pinchThreshold
        : false;

    if (isPinchingRight && !wasPinchingRight) {
        if (nowMs() - lastPinchTime > pinchCooldownMs) {
            lastPinchTime = nowMs();
            updateSnapshotFromCurrentVideoFrame();
        }
    }

    wasPinchingRight = isPinchingRight;
}

// ---------- 启动摄像头 ----------
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

// ---------- 初始化 XR ----------
async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: {
                sessionMode: "immersive-ar",
                referenceSpaceType: "local-floor"
            }
        });

        xrHelper.baseExperience.featuresManager.enableFeature(
            BABYLON.WebXRFeatureName.HAND_TRACKING,
            "latest",
            { xrInput: xrHelper.input }
        );

        xrHelper.input.onControllerAddedObservable.add((input) => {
            const side = input.inputSource?.handedness;

            if (side === "left") {
                leftHandInput = input;
                console.log("Left hand connected");
            } else if (side === "right") {
                rightHandInput = input;
                console.log("Right hand connected");
            }
        });

        xrHelper.input.onControllerRemovedObservable.add((input) => {
            const side = input.inputSource?.handedness;

            if (side === "left" && leftHandInput === input) {
                leftHandInput = null;
                isGrabbing = false;
                grabOffset = null;
                wasPinchingLeft = false;
            } else if (side === "right" && rightHandInput === input) {
                rightHandInput = null;
                wasPinchingRight = false;
            }
        });

        setStatus("XR Ready.");
    } catch (e) {
        console.error(e);
        setStatus("XR error: " + e.message);
    }
}

// ---------- 启动程序 ----------
async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

    new BABYLON.HemisphericLight(
        "light",
        new BABYLON.Vector3(0, 1, 0),
        scene
    );

    snapshotPanel = BABYLON.MeshBuilder.CreatePlane(
        "snapshotPanel",
        {
            width: PANEL_WORLD_WIDTH,
            height: PANEL_WORLD_HEIGHT,
            sideOrientation: BABYLON.Mesh.DOUBLESIDE
        },
        scene
    );

    snapshotTexture = new BABYLON.DynamicTexture(
        "sTex",
        { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT },
        scene
    );
    snapshotTextureCtx = snapshotTexture.getContext();

    // 给初始 texture 一个透明底
    snapshotTextureCtx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
    snapshotTexture.update();

    snapshotMaterial = new BABYLON.StandardMaterial("sMat", scene);
    snapshotMaterial.diffuseTexture = snapshotTexture;
    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
    snapshotMaterial.disableLighting = true;

    snapshotPanel.material = snapshotMaterial;
    snapshotPanel.setEnabled(false);

    setupPointerLogic();
    await startCamera();
    await initXR();

    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });

    window.addEventListener("resize", () => {
        engine.resize();
    });
}

bootstrap();