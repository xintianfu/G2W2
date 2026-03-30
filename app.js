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
const pinchThreshold = 0.04;
let wasPinchingRight = false;

// 抓取状态
let isGrabbingLeft = false;

// 面板物理与纹理尺寸
const PANEL_TEX_SIZE = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `Status: ${text}`;
    console.log(text);
}

// ---------- 1. 核心修复：左手坐标镜像矫正 ----------
function getCorrectedLeftPos(controller) {
    let rawPos = controller.pointer.position;
    // 解决左手瞬移到身后、移动反向的问题：反转 X 和 Z 轴
    return new BABYLON.Vector3(-rawPos.x, rawPos.y, -rawPos.z);
}

// ---------- 2. 核心修复：截图与内容镜像修正 ----------
function updateSnapshot() {
    if (!video.videoWidth || video.readyState < 2) return;

    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);

    // 绘制前进行水平翻转，确保快照内容方位正确（不反）
    ctx.save();
    ctx.translate(PANEL_TEX_SIZE, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    ctx.restore();

    snapshotTexture.update();

    // 将面板放置在当前相机视线前方 0.5m
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI);
    snapshotPanel.setEnabled(true);
    setStatus("Snapshot Updated (Browse Mode)");
}

// ---------- 3. 绘图逻辑：射线笔迹绘制 ----------
function drawLineOnTexture(uv1, uv2) {
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    
    // 将 UV 坐标映射到纹理像素（考虑镜像适配）
    const x1 = (1 - uv1.x) * PANEL_TEX_SIZE;
    const y1 = (1 - uv1.y) * PANEL_TEX_SIZE;
    const x2 = (1 - uv2.x) * PANEL_TEX_SIZE;
    const y2 = (1 - uv2.y) * PANEL_TEX_SIZE;

    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    snapshotTexture.update();
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

        // A. 模式切换：快速点击面板（POINTERDOWN）
        if (type === BABYLON.PointerEventTypes.POINTERDOWN) {
            const now = performance.now();
            // 如果不是在连续绘图，则判定为“点击切换”
            if (!isDrawing) {
                mode = (mode === "browse") ? "draw" : "browse";
                setStatus(`Mode: ${mode.toUpperCase()}`);
            }

            if (mode === "draw" && uv) {
                isDrawing = true;
                lastDrawUV = uv;
            }
        }

        // B. 绘图：POINTERMOVE (仅在 Draw 模式下有效)
        else if (type === BABYLON.PointerEventTypes.POINTERMOVE && mode === "draw" && isDrawing && uv) {
            if (lastDrawUV) drawLineOnTexture(lastDrawUV, uv);
            lastDrawUV = uv;
        }

        // C. 抬笔
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
                const correctedPos = getCorrectedLeftPos(controller);
                snapshotPanel.setAbsolutePosition(correctedPos);
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            } else {
                isGrabbingLeft = false;
            }
        } 
        
        // --- 右手：截图指令 (仅在 Browse 模式下监听捏合) ---
        else if (side === "right") {
            if (mode === "browse") {
                if (isTriggered && !wasPinchingRight) {
                    const now = performance.now();
                    if (now - lastPinchTime > pinchCooldownMs) {
                        lastPinchTime = now;
                        updateSnapshot();
                    }
                }
                wasPinchingRight = !!isTriggered;
            }
        }
    });
}

// ---------- 6. 初始化与启动 ----------
async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        
        // 开启手势追踪特征
        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });
        
        setStatus("XR Ready. Entry AR.");
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
        setStatus("Camera Connected");
    } catch (e) { setStatus("Camera Error"); }

    await initXR();
    setupPointerLogic();

    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });
}

bootstrap();