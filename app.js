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
const pinchCooldownMs = 1200;
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

// ---------- 截图与保存逻辑 ----------
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
    
    // 截图后放置在相机前
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.6));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    // 自动保存
    const dataURL = snapshotTexture.getContext().canvas.toDataURL("image/jpeg", 0.9);
    const link = document.createElement("a");
    link.href = dataURL;
    link.download = `Shot_${Date.now()}.jpg`;
    link.click();
}

// ---------- 绘画逻辑 (仅限右手) ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        // 核心过滤：如果是左手触发的 Pointer 事件，直接无视
        if (xrHelper && xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
            const inputSource = xrHelper.pointerSelection.getPointerContext(pointerInfo.event.pointerId)?.inputSource;
            if (inputSource && inputSource.handedness === "left") return;
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

// ---------- 手势与搬运逻辑 ----------
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
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    // 1. 左手搬运更新 (如果正在抓取，强行同步)
    if (isGrabbing && leftHandInput) {
        const thumb = getJointPos(leftHandInput, "thumb-tip");
        const index = getJointPos(leftHandInput, "index-finger-tip");
        if (thumb && index) {
            const pinchPos = BABYLON.Vector3.Center(thumb, index);
            const dist = BABYLON.Vector3.Distance(thumb, index);
            
            // 如果手指张开，释放抓取
            if (dist > pinchThreshold + 0.02) {
                isGrabbing = false;
                snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
            } else {
                // 1:1 跟随，解决反向移动
                snapshotPanel.setAbsolutePosition(pinchPos);
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            }
        }
    }

    // 2. 右手 Pinch 截图检测
    const rThumb = getJointPos(rightHandInput, "thumb-tip");
    const rIndex = getJointPos(rightHandInput, "index-finger-tip");
    const isPinchingRight = (rThumb && rIndex) ? BABYLON.Vector3.Distance(rThumb, rIndex) < pinchThreshold : false;

    if (isPinchingRight && !wasPinchingRight) {
        if (nowMs() - lastPinchTime > pinchCooldownMs) {
            lastPinchTime = nowMs();
            updateSnapshotFromCurrentVideoFrame();
        }
    }
    wasPinchingRight = isPinchingRight;
}

// ---------- 启动与初始化 ----------
async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
}

async function initXR() {
    xrHelper = await scene.createDefaultXRExperienceAsync({
        uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
    });
    
    xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", { xrInput: xrHelper.input });

    xrHelper.input.onControllerAddedObservable.add((input) => {
        const side = input.inputSource.handedness;
        if (side === "left") {
            leftHandInput = input;
            // 关键：当左手射线点变蓝并捏合时触发抓取
            input.onSelectTriggeredObservable.add(() => {
                const pick = scene.pickWithRay(input.getWorldPointerRay());
                if (pick.hit && pick.pickedMesh === snapshotPanel) {
                    isGrabbing = true;
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(0.5, 0.8, 1); // 变蓝提示抓住
                }
            });
        } else {
            rightHandInput = input;
        }
    });
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
    await startCamera();
    await initXR();

    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });
}

bootstrap();