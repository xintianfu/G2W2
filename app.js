const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

// 基础变量
let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// 交互状态
let isGrabbingLeft = false; 
let wasPinchingRight = false;
let lastPinchTime = 0;
// 新增：用于记录上一帧手的位置，解决移动反向问题
let lastLeftHandPos = null; 

// 判定阈值
const PINCH_THRESHOLD = 0.02; 
const COOLDOWN = 1500;

const PANEL_TEX_SIZE = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
    console.log(text);
}

// 获取指尖坐标 (保底逻辑)
function getHandPoint(controller, jointName) {
    if (controller?.inputSource?.hand) {
        const joint = controller.inputSource.hand.get(jointName);
        const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
        const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
        if (frame && joint && ref) {
            const pose = frame.getJointPose(joint, ref);
            if (pose) return new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        }
    }
    return controller.pointer.position.clone();
}

// ---------- 核心修复：解决移动反向的 updateLoop ----------
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    xrHelper.input.controllers.forEach((controller) => {
        const side = controller.inputSource.handedness;
        const thumb = getHandPoint(controller, "thumb-tip");
        const index = getHandPoint(controller, "index-finger-tip");
        if (!thumb || !index) return;

        const dist = BABYLON.Vector3.Distance(thumb, index);
        const isPinching = dist < PINCH_THRESHOLD;
        const currentPinchPos = BABYLON.Vector3.Center(thumb, index);

        // --- 左手：修正位移逻辑 ---
        if (side === "left") {
            if (isPinching && snapshotPanel.isEnabled()) {
                if (!isGrabbingLeft) {
                    isGrabbingLeft = true;
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.7, 1);
                    setStatus("左手抓取中...");
                    // 初始吸附：让面板中心直接对齐捏合点
                    snapshotPanel.setAbsolutePosition(currentPinchPos);
                } else {
                    // 【修正位移的关键】
                    // 1. 如果有上一帧的位置，计算手移动了多少 (delta)
                    if (lastLeftHandPos) {
                        const delta = currentPinchPos.subtract(lastLeftHandPos);
                        // 2. 将这个位移应用到面板当前的绝对坐标上
                        snapshotPanel.position.addInPlace(delta);
                    }
                }
                // 记录当前位置供下一帧使用
                lastLeftHandPos = currentPinchPos.clone();
                
                // 面板面向用户
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            } else {
                if (isGrabbingLeft) {
                    isGrabbingLeft = false;
                    lastLeftHandPos = null; // 重置
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
                    setStatus("左手已放开");
                }
            }
        } 
        
        // --- 右手：截图逻辑保持不变 ---
        else if (side === "right") {
            if (isPinching && !wasPinchingRight) {
                if (performance.now() - lastPinchTime > COOLDOWN) {
                    lastPinchTime = performance.now();
                    takeSnapshot();
                    setStatus("右手截图成功");
                }
            }
            wasPinchingRight = isPinching;
        }
    });
}

// 截图功能
function takeSnapshot() {
    if (!video.videoWidth) return;
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    
    ctx.save();
    ctx.translate(PANEL_TEX_SIZE / 2, PANEL_TEX_SIZE / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_SIZE / 2, -PANEL_TEX_SIZE / 2);
    ctx.drawImage(video, 0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    ctx.restore();
    
    snapshotTexture.update();
    
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    const link = document.createElement("a");
    link.href = snapshotTexture.getContext().canvas.toDataURL("image/jpeg");
    link.download = `Snapshot_${Date.now()}.jpg`;
    link.click();
}

async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });
    } catch (e) { setStatus("XR 初始化失败"); }
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("sPanel", { width: PANEL_WORLD_WIDTH, height: PANEL_WORLD_HEIGHT, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_SIZE, height: PANEL_TEX_SIZE }, scene);
    snapshotTextureCtx = snapshotTexture.getContext();
    snapshotMaterial = new BABYLON.StandardMaterial("sMat", scene);
    snapshotMaterial.diffuseTexture = snapshotTexture;
    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
    snapshotMaterial.disableLighting = true;
    snapshotPanel.material = snapshotMaterial;
    snapshotPanel.setEnabled(false);

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        await video.play();
    } catch (e) { setStatus("摄像头开启失败"); }

    await initXR();
    engine.runRenderLoop(() => { updateLoop(); scene.render(); });
}

bootstrap();