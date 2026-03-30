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
const pinchCooldownMs = 1500;
// 抓取感应距离：0.15米 (15厘米)
const grabDistance = 0.15; 

let lastPinchTime = 0;
let wasPinchingRight = false;

const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

// ---------- 工具函数 ----------
function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
    console.log(text);
}

function nowMs() { return performance.now(); }

// ---------- 截图逻辑 (保持稳定) ----------
function updateSnapshotFromCurrentVideoFrame() {
    if (!video.videoWidth || video.videoWidth < 100) return;
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

    const videoAspect = video.videoWidth / video.videoHeight;
    const texAspect = PANEL_TEX_WIDTH / PANEL_TEX_HEIGHT;
    let drawWidth, drawHeight, offsetX, offsetY;

    if (videoAspect > texAspect) {
        drawHeight = PANEL_TEX_HEIGHT; drawWidth = drawHeight * videoAspect;
        offsetX = (PANEL_TEX_WIDTH - drawWidth) / 2; offsetY = 0;
    } else {
        drawWidth = PANEL_TEX_WIDTH; drawHeight = drawWidth / videoAspect;
        offsetX = 0; offsetY = (PANEL_TEX_HEIGHT - drawHeight) / 2;
    }

    ctx.save();
    ctx.translate(PANEL_TEX_WIDTH / 2, PANEL_TEX_HEIGHT / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_WIDTH / 2, -PANEL_TEX_HEIGHT / 2);
    ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
    ctx.restore();

    snapshotTexture.update();
    
    // 截图出现在眼前
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    // 自动保存
    try {
        const dataURL = snapshotTexture.getContext().canvas.toDataURL("image/jpeg", 0.85);
        const link = document.createElement("a");
        link.href = dataURL;
        link.download = `QuestAR_${Date.now()}.jpg`;
        link.click();
    } catch(e) {}
}

// ---------- 绘画过滤 (右手专用) ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        if (xrHelper && xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
            try {
                if (!xrHelper.pointerSelection) return;
                const context = xrHelper.pointerSelection.getPointerContext(pointerInfo.event.pointerId);
                if (context?.inputSource?.handedness === "left") return; // 屏蔽左手绘画
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

// ---------- 核心：手部追踪与物理抓取 ----------
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

    // --- 1. 左手物理“吸附”搬运 ---
    // 我们用掌心(wrist)或者中指根部来代表手的位置，比指尖更稳定
    const leftPalm = getJointPos(leftHandInput, "wrist"); 
    if (leftPalm && snapshotPanel.isEnabled()) {
        const distance = BABYLON.Vector3.Distance(leftPalm, snapshotPanel.position);
        
        // 靠近就变色提示可抓取
        if (distance < grabDistance) {
            if (!isGrabbing) {
                isGrabbing = true;
                snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.5, 1); // 变蓝
                setStatus("已抓取面板 (靠近吸附)");
            }
        } 

        if (isGrabbing) {
            // 如果手离开太远 (0.3m)，自动释放
            if (distance > 0.3) {
                isGrabbing = false;
                snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
                setStatus("已释放面板");
            } else {
                // 面板平滑跟随手部位置
                snapshotPanel.position = BABYLON.Vector3.Lerp(snapshotPanel.position, leftPalm, 0.2);
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            }
        }
    }

    // --- 2. 右手 Pinch 截图 ---
    const rThumb = getJointPos(rightHandInput, "thumb-tip");
    const rIndex = getJointPos(rightHandInput, "index-finger-tip");
    const isPinchingRight = (rThumb && rIndex) ? BABYLON.Vector3.Distance(rThumb, rIndex) < pinchThreshold : false;

    if (isPinchingRight && !wasPinchingRight) {
        if (nowMs() - lastPinchTime > pinchCooldownMs) {
            lastPinchTime = nowMs();
            updateSnapshotFromCurrentVideoFrame();
            setStatus("快照已生成");
        }
    }
    wasPinchingRight = isPinchingRight;
}

// ---------- 初始化流程 ----------
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

    xrHelper.input.onControllerAddedObservable.add((input) => {
        if (input.inputSource.handedness === "left") leftHandInput = input;
        else rightHandInput = input;
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