const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// 交互状态
let isGrabbingLeft = false; 
let wasPinchingRight = false;
let lastPinchTime = 0;
let lastLeftHandPos = null; // 用于计算移动增量

// 参数配置
const PINCH_THRESHOLD = 0.04; 
const COOLDOWN = 1000; // 冷却时间 1 秒
const PANEL_TEX_SIZE = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
}

// 获取关节或射线起点
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

// --- 核心：动态截图函数（修正镜像 + 强制刷新内容） ---
function takeSnapshot() {
    // 检查视频流是否准备好
    if (!video.videoWidth || video.readyState < 2) {
        setStatus("摄像头流尚未就绪");
        return;
    }

    const ctx = snapshotTextureCtx;
    // 1. 彻底清除 Canvas 状态并重置矩阵
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    
    // 2. 修正镜像：处理画面左右翻转
    // 我们先平移再缩放，实现水平镜像
    ctx.save();
    ctx.translate(PANEL_TEX_SIZE, 0);
    ctx.scale(-1, 1); 
    
    // 3. 绘制当前视频帧 (实时抓取 video 元素内容)
    ctx.drawImage(video, 0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    ctx.restore();
    
    // 4. 重要：强制通知引擎将 Canvas 内容上传到 GPU
    snapshotTexture.update();
    
    // 5. 瞬间将面板放置在当前相机正前方 0.5m
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    setStatus("快照已更新：" + new Date().toLocaleTimeString());

    // 触发保存到本地 (Quest 浏览器会提示下载)
    // try {
    //     const link = document.createElement("a");
    //     link.href = snapshotTexture.getContext().canvas.toDataURL("image/jpeg", 0.85);
    //     link.download = `Shot_${Date.now()}.jpg`;
    //     link.click();
    // } catch(e) {}
}

// 渲染循环：处理位移与手势判定
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

        // --- 左手：位移修正算法 ---
        if (side === "left") {
            if (isPinching && snapshotPanel.isEnabled()) {
                if (!isGrabbingLeft) {
                    isGrabbingLeft = true;
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.7, 1);
                    // 初始吸附
                    snapshotPanel.setAbsolutePosition(currentPinchPos);
                } else if (lastLeftHandPos) {
                    // 计算这一帧的位移增量
                    const moveVector = currentPinchPos.subtract(lastLeftHandPos);
                    
                    // 【左右位移修正】将 X 轴取反
                    moveVector.x = -moveVector.x; 
                    moveVector.z = -moveVector.z
                    
                    // 应用位移
                    snapshotPanel.position.addInPlace(moveVector);
                }
                lastLeftHandPos = currentPinchPos.clone();
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            } else {
                if (isGrabbingLeft) {
                    isGrabbingLeft = false;
                    lastLeftHandPos = null;
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
                    setStatus("左手松开");
                }
            }
        } 
        // --- 右手：截图交互 ---
        else if (side === "right") {
            if (isPinching && !wasPinchingRight) {
                if (performance.now() - lastPinchTime > COOLDOWN) {
                    lastPinchTime = performance.now();
                    takeSnapshot(); // 触发实时截图
                }
            }
            wasPinchingRight = isPinching;
        }
    });
}

async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        // 显式开启手势追踪特征
        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });
        setStatus("XR 已准备就绪");
    } catch (e) {
        setStatus("XR 初始化失败");
    }
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    // 面板设置
    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("sPanel", { 
        width: PANEL_WORLD_WIDTH, 
        height: PANEL_WORLD_HEIGHT, 
        sideOrientation: BABYLON.Mesh.DOUBLESIDE 
    }, scene);
    
    // 动态纹理初始化
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_SIZE, height: PANEL_TEX_SIZE }, scene);
    snapshotTextureCtx = snapshotTexture.getContext();
    
    snapshotMaterial = new BABYLON.StandardMaterial("sMat", scene);
    snapshotMaterial.diffuseTexture = snapshotTexture;
    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
    snapshotMaterial.disableLighting = true; 
    snapshotPanel.material = snapshotMaterial;
    snapshotPanel.setEnabled(false);

    // 启动摄像头实时画面
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment", width: 1280, height: 720 } 
        });
        video.srcObject = stream;
        await video.play();
        setStatus("摄像头已连接");
    } catch (e) {
        setStatus("无法访问摄像头");
    }

    await initXR();
    engine.runRenderLoop(() => { 
        updateLoop(); 
        scene.render(); 
    });
}

bootstrap();