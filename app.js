const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// 交互状态
let mode = "browse"; // browse | draw
let isDrawing = false;
let lastDrawUV = null;
let lastPinchTime = 0;
const pinchCooldownMs = 1200;
let wasPinchingRight = false;

// 搬运状态
let isGrabbingLeft = false;

// 面板与纹理参数
const PANEL_TEX_SIZE = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `Status: ${text}`;
    console.log(text);
}

// ---------- 1. 坐标修正：解决左手飞到身后和移动反向 ----------
function getCorrectedPosition(controller) {
    let rawPos = controller.pointer.position;
    // 【核心修正】反转水平面的 X 和 Z 坐标
    // 这会将设备误判在“身后镜像区”的点强制拉回到“面前交互区”
    return new BABYLON.Vector3(-rawPos.x, rawPos.y, -rawPos.z);
}

// ---------- 2. 截图更新：捕获当前视角的实时画面 ----------
function updateSnapshot() {
    if (!video.videoWidth || video.readyState < 2) {
        setStatus("Waiting for real-time video...");
        return;
    }

    const ctx = snapshotTextureCtx;
    // 强制重置绘图矩阵，防止 Canvas 状态锁死
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);

    // 修正内容左右反转，让快照里的文字变正
    ctx.save();
    ctx.translate(PANEL_TEX_SIZE, 0);
    ctx.scale(-1, 1); 
    // 抓取 video 元素此时此刻的实时像素帧
    ctx.drawImage(video, 0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    ctx.restore();

    // 强行刷新纹理到 GPU
    snapshotTexture.update(true);

    // 将面板放置在此时相机的正前方 0.5m
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    setStatus("Snapshot Captured: " + new Date().toLocaleTimeString());
}

// ---------- 3. 绘图逻辑：射线笔迹绘制 ----------
function drawLineOnTexture(uv1, uv2) {
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    
    // 适配镜像后的纹理 X 轴映射
    const x1 = (1 - uv1.x) * PANEL_TEX_SIZE;
    const y1 = (1 - uv1.y) * PANEL_TEX_SIZE;
    const x2 = (1 - uv2.x) * PANEL_TEX_SIZE;
    const y2 = (1 - uv2.y) * PANEL_TEX_SIZE;

    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    snapshotTexture.update(true);
}

// ---------- 4. 交互逻辑：模式切换与 Pointer 监听 ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        const type = pointerInfo.type;
        const pick = pointerInfo.pickInfo;
        
        // 只有射中面板才处理
        if (!pick || !pick.hit || pick.pickedMesh !== snapshotPanel) {
            if (type === BABYLON.PointerEventTypes.POINTERUP) isDrawing = false;
            return;
        }

        const uv = pick.getTextureCoordinates();

        // 点击面板切换到绘画模式
        if (type === BABYLON.PointerEventTypes.POINTERDOWN) {
            if (mode === "browse") {
                mode = "draw";
                setStatus("Mode: DRAWING");
            } else {
                isDrawing = true;
                lastDrawUV = uv;
            }
        } 
        // 绘画移动
        else if (type === BABYLON.PointerEventTypes.POINTERMOVE && mode === "draw" && isDrawing && uv) {
            if (lastDrawUV) drawLineOnTexture(lastDrawUV, uv);
            lastDrawUV = uv;
        } 
        // 抬笔
        else if (type === BABYLON.PointerEventTypes.POINTERUP) {
            isDrawing = false;
            lastDrawUV = null;
        }
    });
}

// ---------- 5. 实时循环：处理搬运与截图触发 ----------
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    xrHelper.input.controllers.forEach((controller) => {
        const side = controller.inputSource.handedness;
        const isTriggered = controller.inputSource.gamepad?.buttons[0]?.pressed;

        // --- 左手：独立镜像搬运逻辑 ---
        if (side === "left") {
            if (isTriggered && snapshotPanel.isEnabled()) {
                isGrabbingLeft = true;
                const correctedPos = getCorrectedPosition(controller);
                snapshotPanel.setAbsolutePosition(correctedPos);
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            } else {
                isGrabbingLeft = false;
            }
        } 
        
        // --- 右手：截图指令 (仅在非绘图点击状态下触发) ---
        else if (side === "right") {
            if (isTriggered && !wasPinchingRight && !isDrawing) {
                const now = performance.now();
                if (now - lastPinchTime > pinchCooldownMs) {
                    lastPinchTime = now;
                    updateSnapshot();
                }
            }
            wasPinchingRight = !!isTriggered;
        }
    });
}

// ---------- 6. 初始化与启动 ----------
async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        
        // 显式开启手势追踪
        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });
        
        setStatus("XR Ready. Entered AR.");
    } catch (e) {
        setStatus("XR Failed: " + e.message);
    }
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

    // 启动摄像头
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment", width: 1280, height: 720 } 
        });
        video.srcObject = stream;
        await video.play();
        setStatus("Camera Real-time Ready");
    } catch (e) { setStatus("Camera Error"); }

    await initXR();
    setupPointerLogic();

    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });
}

bootstrap();