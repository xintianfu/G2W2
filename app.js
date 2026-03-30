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
let isGrabbingLeft = false; // 左手是否正在抓取
let lastDrawUV = null;

const pinchThreshold = 0.04;    // 捏合判定距离 (4厘米)
const grabDistance = 0.35;      // 抓取感应范围 (35厘米)
const pinchCooldownMs = 1500;   // 截图冷却

let lastPinchTime = 0;
let wasPinchingRight = false;

const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
    console.log(text);
}

function nowMs() { return performance.now(); }

// ---------- 1. 绘画逻辑 (仅限右手) ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        if (xrHelper && xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
            try {
                if (!xrHelper.pointerSelection) return;
                const context = xrHelper.pointerSelection.getPointerContext(pointerInfo.event.pointerId);
                // 屏蔽左手绘画
                if (context?.inputSource?.handedness === "left") return;
            } catch (e) { return; }
        }

        const type = pointerInfo.type;
        const pickInfo = pointerInfo.pickInfo;
        const isHit = pickInfo?.hit && pickInfo.pickedMesh === snapshotPanel;
        const uv = isHit ? pickInfo.getTextureCoordinates() : null;

        if (type === BABYLON.PointerEventTypes.POINTERDOWN && uv) {
            isDrawing = true; lastDrawUV = uv; drawAtUV(uv, true);
        } else if (type === BABYLON.PointerEventTypes.POINTERMOVE && isDrawing) {
            if (uv) { drawAtUV(uv, false); lastDrawUV = uv; } 
            else { lastDrawUV = null; }
        } else if (type === BABYLON.PointerEventTypes.POINTERUP) {
            isDrawing = false; lastDrawUV = null;
        }
    });
}

function drawAtUV(uv, isFirstPoint) {
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); 
    const x = (1 - uv.x) * PANEL_TEX_WIDTH;
    const y = (1 - uv.y) * PANEL_TEX_HEIGHT; 
    ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = 10; ctx.lineCap = "round";
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

// ---------- 2. 截图逻辑 ----------
function updateSnapshotFromCurrentVideoFrame() {
    if (!video.videoWidth || video.videoWidth < 100) return;
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

    const vAspect = video.videoWidth / video.videoHeight;
    const tAspect = PANEL_TEX_WIDTH / PANEL_TEX_HEIGHT;
    let dW, dH, oX, oY;

    if (vAspect > tAspect) { dH = PANEL_TEX_HEIGHT; dW = dH * vAspect; oX = (PANEL_TEX_WIDTH - dW) / 2; oY = 0; }
    else { dW = PANEL_TEX_WIDTH; dH = dW / vAspect; oX = 0; oY = (PANEL_TEX_HEIGHT - dH) / 2; }

    ctx.save();
    ctx.translate(PANEL_TEX_WIDTH / 2, PANEL_TEX_HEIGHT / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_WIDTH / 2, -PANEL_TEX_HEIGHT / 2);
    ctx.drawImage(video, oX, oY, dW, dH);
    ctx.restore();
    snapshotTexture.update();
    
    // 截图出现在眼前
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    try {
        const dataURL = snapshotTexture.getContext().canvas.toDataURL("image/jpeg", 0.85);
        const link = document.createElement("a");
        link.href = dataURL;
        link.download = `Shot_${Date.now()}.jpg`;
        link.click();
    } catch(e) {}
}

// ---------- 3. 核心：左右手物理距离判定循环 ----------
function getJointPosFromInput(input, name) {
    if (!input?.inputSource?.hand) return null;
    const joint = input.inputSource.hand.get(name);
    const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
    const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
    if (!frame || !joint || !ref) return null;
    const pose = frame.getJointPose(joint, ref);
    return pose ? new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z) : null;
}

function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    // 每一帧都扫描控制器
    xrHelper.input.controllers.forEach((controller) => {
        const side = controller.inputSource.handedness;
        const thumb = getJointPosFromInput(controller, "thumb-tip");
        const index = getJointPosFromInput(controller, "index-finger-tip");
        
        if (!thumb || !index) return;

        const dist = BABYLON.Vector3.Distance(thumb, index);
        const isPinching = dist < pinchThreshold;
        const pinchPos = BABYLON.Vector3.Center(thumb, index);

        // --- 左手：控制搬运 (逻辑与右手完全一致，仅功能不同) ---
        if (side === "left") {
            if (isPinching && snapshotPanel.isEnabled()) {
                // 如果捏合时离面板够近，或者已经在抓取中
                const distToPanel = BABYLON.Vector3.Distance(pinchPos, snapshotPanel.position);
                
                if (isGrabbingLeft || distToPanel < grabDistance) {
                    if (!isGrabbingLeft) {
                        isGrabbingLeft = true;
                        snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.7, 1); // 变蓝反馈
                        setStatus("左手已抓住面板");
                    }
                    // 执行跟随移动 (1:1 跟随)
                    snapshotPanel.setAbsolutePosition(pinchPos);
                    snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
                }
            } else {
                // 松手
                if (isGrabbingLeft) {
                    isGrabbingLeft = false;
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
                    setStatus("左手已松开");
                }
            }
        } 
        // --- 右手：控制截图 ---
        else if (side === "right") {
            if (isPinching && !wasPinchingRight) {
                if (nowMs() - lastPinchTime > pinchCooldownMs) {
                    lastPinchTime = nowMs();
                    updateSnapshotFromCurrentVideoFrame();
                    setStatus("右手截图成功");
                }
            }
            wasPinchingRight = isPinching;
        }
    });
}

// ---------- 启动流程 ----------
async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
}

async function initXR() {
    xrHelper = await scene.createDefaultXRExperienceAsync({
        uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
    });
    
    xrHelper.baseExperience.onStateChangedObservable.add((state) => {
        if (state === BABYLON.WebXRState.IN_XR) {
            xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", { xrInput: xrHelper.input });
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