const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// 交互状态
let isGrabbingLeft = false; 
let isDrawingRight = false; // 是否正在绘图
let lastSnapshotTime = 0;
let lastDrawUV = null;

// 配置参数
const SNAPSHOT_COOLDOWN = 1500; // 截图冷却
const PANEL_TEX_SIZE = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
}

/**
 * 【左手专用】镜像坐标矫正
 * 仅用于搬运，将身后的坐标拉回身前
 */
function getCorrectedLeftPos(controller) {
    let rawPos = controller.pointer.position;
    // 强制执行 X 和 Z 轴镜像翻转
    return new BABYLON.Vector3(-rawPos.x, rawPos.y, -rawPos.z);
}

/**
 * 【动态截图】修正镜像并重置内容
 */
function takeSnapshot() {
    if (!video.videoWidth || video.readyState < 2) return;
    
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    
    // 修正内容镜像，让文字变正
    ctx.save();
    ctx.translate(PANEL_TEX_SIZE, 0);
    ctx.scale(-1, 1); 
    ctx.drawImage(video, 0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    ctx.restore();
    
    snapshotTexture.update();
    
    // 面板出现在相机正前方 0.5m
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);
    setStatus("快照更新成功");
}

/**
 * 【射线绘画】基于蓝色圆点落点的绘图逻辑
 */
function drawByRay(uv, isNewPath) {
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    
    // 适配镜像纹理：将 UV 坐标映射到像素点
    const x = (1 - uv.x) * PANEL_TEX_SIZE;
    const y = (1 - uv.y) * PANEL_TEX_SIZE;

    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";

    if (isNewPath || !lastDrawUV) {
        ctx.beginPath();
        ctx.moveTo(x, y);
    } else {
        const lx = (1 - lastDrawUV.x) * PANEL_TEX_SIZE;
        const ly = (1 - lastDrawUV.y) * PANEL_TEX_SIZE;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(x, y);
        ctx.stroke();
    }
    lastDrawUV = uv;
    snapshotTexture.update();
}

/**
 * 实时逻辑循环
 */
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    xrHelper.input.controllers.forEach((controller) => {
        const side = controller.inputSource.handedness;
        // 检测按下状态 (Pinch 在模拟控制器模式下对应按钮 0)
        const isTriggered = controller.inputSource.gamepad?.buttons[0]?.pressed;

        // --- 左手：镜像吸附搬运 ---
        if (side === "left") {
            if (isTriggered && snapshotPanel.isEnabled()) {
                isGrabbingLeft = true;
                const correctedPos = getCorrectedLeftPos(controller);
                snapshotPanel.setAbsolutePosition(correctedPos);
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
                setStatus("左手搬运中...");
            } else {
                isGrabbingLeft = false;
            }
        } 
        
        // --- 右手：射线绘画 + 截图双模逻辑 ---
        else if (side === "right") {
            if (isTriggered) {
                // 1. 发射射线检测
                const ray = controller.getWorldPointerRay();
                const pick = scene.pickWithRay(ray);
                
                if (pick.hit && pick.pickedMesh === snapshotPanel) {
                    // 如果射中了面板：进入绘画模式
                    const uv = pick.getTextureCoordinates();
                    drawByRay(uv, !isDrawingRight);
                    isDrawingRight = true;
                    setStatus("正在绘画...");
                } else {
                    // 如果捏合了但没射中：不触发绘画
                    isDrawingRight = false;
                }
            } else {
                // 2. 松开捏合时的逻辑判定
                if (isDrawingRight) {
                    // 刚才在画画，现在停笔
                    isDrawingRight = false;
                    lastDrawUV = null;
                    setStatus("停止绘画");
                } else if (performance.now() - lastSnapshotTime > SNAPSHOT_COOLDOWN) {
                    // 刚才没在画画（指着空气捏合的），视为截图指令
                    lastSnapshotTime = performance.now();
                    takeSnapshot();
                }
            }
        }
    });
}

async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        // 开启手势支持
        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });
        setStatus("XR 已就绪");
    } catch (e) { setStatus("XR 启动失败"); }
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    // 面板设置
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

    // 启动视频流
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment", width: 1280, height: 720 } 
        });
        video.srcObject = stream;
        await video.play();
        setStatus("摄像头已连接");
    } catch (e) { setStatus("无法访问摄像头"); }

    await initXR();
    engine.runRenderLoop(() => { 
        updateLoop(); 
        scene.render(); 
    });
}

bootstrap();