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

// 统一判定阈值 (采用你右手验证成功的 4cm)
const PINCH_THRESHOLD = 0.04; 
const COOLDOWN = 1500;

const PANEL_TEX_SIZE = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
    console.log(text);
}

// ---------- 1. 核心算法：获取指尖坐标 (增加保底逻辑) ----------
function getHandPoint(controller, jointName) {
    // 1. 尝试获取高精度骨骼关节 (你看到的关节球)
    if (controller?.inputSource?.hand) {
        const joint = controller.inputSource.hand.get(jointName);
        const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
        const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
        if (frame && joint && ref) {
            const pose = frame.getJointPose(joint, ref);
            if (pose) return new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        }
    }
    // 2. 如果骨骼数据瞬间丢失，使用射线起点作为保底坐标
    return controller.pointer.position;
}

// ---------- 2. 核心循环：实时物理判定交互 ----------
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    xrHelper.input.controllers.forEach((controller) => {
        const side = controller.inputSource.handedness;

        // 获取该手的拇指和食指坐标
        const thumb = getHandPoint(controller, "thumb-tip");
        const index = getHandPoint(controller, "index-finger-tip");
        
        if (!thumb || !index) return;

        // 计算物理距离
        const dist = BABYLON.Vector3.Distance(thumb, index);
        const isPinching = dist < PINCH_THRESHOLD;
        const pinchCenter = BABYLON.Vector3.Center(thumb, index);

        // --- 左手逻辑：捏合即强制吸附 ---
        if (side === "left") {
            if (isPinching && snapshotPanel.isEnabled()) {
                if (!isGrabbingLeft) {
                    isGrabbingLeft = true;
                    // 视觉反馈：变蓝色
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.7, 1); 
                    setStatus("左手捏合：面板已强制吸附");
                }
                
                // 【核心改进】直接把面板坐标设为左手捏合点，实现“隔空吸附”
                snapshotPanel.setAbsolutePosition(pinchCenter);
                // 始终面向用户，避免镜像反向感
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            } else {
                if (isGrabbingLeft) {
                    isGrabbingLeft = false;
                    // 恢复白色
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1); 
                    setStatus("左手松开：已放置面板");
                }
            }
        } 
        
        // --- 右手逻辑：Pinch 截图 (你验证过最稳的逻辑) ---
        else if (side === "right") {
            if (isPinching && !wasPinchingRight) {
                if (performance.now() - lastPinchTime > COOLDOWN) {
                    lastPinchTime = performance.now();
                    takeSnapshot();
                    setStatus("右手 Pinch：快照成功");
                }
            }
            wasPinchingRight = isPinching;
        }
    });
}

// ---------- 3. 截图功能 (带自动保存) ----------
function takeSnapshot() {
    if (!video.videoWidth) return;
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    
    // 修正镜像并绘制
    ctx.save();
    ctx.translate(PANEL_TEX_SIZE / 2, PANEL_TEX_SIZE / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_SIZE / 2, -PANEL_TEX_SIZE / 2);
    ctx.drawImage(video, 0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    ctx.restore();
    
    snapshotTexture.update();
    
    // 面板出现在眼前 0.5 米处
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    // 触发下载
    const link = document.createElement("a");
    link.href = snapshotTexture.getContext().canvas.toDataURL("image/jpeg");
    link.download = `Snapshot_${Date.now()}.jpg`;
    link.click();
}

// ---------- 4. 启动与初始化 ----------
async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        
        // 开启手势追踪
        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });
        
        setStatus("XR 就绪，请进入 AR 模式");
    } catch (e) {
        setStatus("XR 初始化失败");
    }
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    // 面板初始化
    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("sPanel", { 
        width: PANEL_WORLD_WIDTH, 
        height: PANEL_WORLD_HEIGHT, 
        sideOrientation: BABYLON.Mesh.DOUBLESIDE 
    }, scene);
    
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_SIZE, height: PANEL_TEX_SIZE }, scene);
    snapshotTextureCtx = snapshotTexture.getContext();
    
    snapshotMaterial = new BABYLON.StandardMaterial("sMat", scene);
    snapshotMaterial.diffuseTexture = snapshotTexture;
    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
    snapshotMaterial.disableLighting = true;
    snapshotPanel.material = snapshotMaterial;
    snapshotPanel.setEnabled(false);

    // 启动摄像头
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        await video.play();
    } catch (e) { setStatus("摄像头开启失败"); }

    await initXR();
    
    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });
}

bootstrap();