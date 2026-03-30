const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// 交互状态
let isGrabbingLeft = false; 
let wasPinchingRight = false;
let lastPinchTime = 0;

// 配置参数
const PINCH_THRESHOLD = 0.04; 
const COOLDOWN = 1000; 
const PANEL_TEX_SIZE = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
}

/**
 * 【核心修复】镜像坐标矫正函数
 * 解决左手 Pinch 后面板对称飞到背后、左右反向的问题
 */
function getCorrectedPoint(controller, jointName) {
    let rawPos = null;
    
    // 1. 尝试获取关节骨骼坐标
    if (controller?.inputSource?.hand) {
        const joint = controller.inputSource.hand.get(jointName);
        const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
        const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
        if (frame && joint && ref) {
            const pose = frame.getJointPose(joint, ref);
            if (pose) {
                rawPos = new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
            }
        }
    }
    
    // 2. 如果没拿到骨骼，使用射线起点保底
    if (!rawPos) {
        rawPos = controller.pointer.position.clone();
    }

    // 3. 【核心修正】如果当前是左手且出现了镜像对称
    // 我们将 X (左右) 和 Z (前后) 坐标取反，强行把点从身后拉回身前
    if (controller.inputSource.handedness === "left") {
        return new BABYLON.Vector3(-rawPos.x, rawPos.y, -rawPos.z);
    }
    
    return rawPos;
}

/**
 * 【核心修复】动态截图函数
 * 解决内容不刷新、内容左右反转的问题
 */
function takeSnapshot() {
    if (!video.videoWidth || video.readyState < 2) {
        setStatus("等待摄像头流...");
        return;
    }

    const ctx = snapshotTextureCtx;
    // 1. 强制重置绘图上下文，防止缓存
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    
    // 2. 修正画面左右镜像：让文字和环境方位在面板上看起来是正的
    ctx.save();
    ctx.translate(PANEL_TEX_SIZE, 0);
    ctx.scale(-1, 1); 
    
    // 3. 抓取当前实时视频帧
    ctx.drawImage(video, 0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    ctx.restore();
    
    // 4. 通知 Babylon 立即更新 GPU 纹理
    snapshotTexture.update();
    
    // 5. 将面板放置在相机正前方 0.5 米
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    setStatus("快照更新成功: " + new Date().toLocaleTimeString().split(' ')[0]);
}

/**
 * 实时交互循环
 */
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    xrHelper.input.controllers.forEach((controller) => {
        const side = controller.inputSource.handedness;
        
        // 获取经过坐标矫正后的位置
        const thumb = getCorrectedPoint(controller, "thumb-tip");
        const index = getCorrectedPoint(controller, "index-finger-tip");
        
        if (!thumb || !index) return;

        const dist = BABYLON.Vector3.Distance(thumb, index);
        const isPinching = dist < PINCH_THRESHOLD;
        const pinchCenter = BABYLON.Vector3.Center(thumb, index);

        // --- 左手：控制吸附搬运 ---
        if (side === "left") {
            if (isPinching && snapshotPanel.isEnabled()) {
                if (!isGrabbingLeft) {
                    isGrabbingLeft = true;
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.7, 1);
                }
                
                // 直接同步到矫正后的坐标，解决“瞬移到身后”
                snapshotPanel.setAbsolutePosition(pinchCenter);
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            } else {
                if (isGrabbingLeft) {
                    isGrabbingLeft = false;
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
                }
            }
        } 
        // --- 右手：控制截图 ---
        else if (side === "right") {
            if (isPinching && !wasPinchingRight) {
                if (performance.now() - lastPinchTime > COOLDOWN) {
                    lastPinchTime = performance.now();
                    takeSnapshot(); 
                }
            }
            wasPinchingRight = isPinching;
        }
    });
}

/**
 * 初始化 WebXR
 */
async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        
        // 显式开启手势特征
        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });
        
        setStatus("XR 就绪，请进入 AR");
    } catch (e) {
        setStatus("XR 初始化失败");
    }
}

/**
 * 程序启动入口
 */
async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    // 面板与材质初始化
    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("sPanel", { 
        width: PANEL_WORLD_WIDTH, height: PANEL_WORLD_HEIGHT, sideOrientation: BABYLON.Mesh.DOUBLESIDE 
    }, scene);
    
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_SIZE, height: PANEL_TEX_SIZE }, scene);
    snapshotTextureCtx = snapshotTexture.getContext();
    
    snapshotMaterial = new BABYLON.StandardMaterial("sMat", scene);
    snapshotMaterial.diffuseTexture = snapshotTexture;
    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
    snapshotMaterial.disableLighting = true; 
    snapshotPanel.material = snapshotMaterial;
    snapshotPanel.setEnabled(false);

    // 启动实时视频流
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment", width: 1280, height: 720 } 
        });
        video.srcObject = stream;
        await video.play();
        setStatus("视频流已连接");
    } catch (e) {
        setStatus("请开启摄像头权限并使用 HTTPS");
    }

    await initXR();
    
    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });
}

bootstrap();