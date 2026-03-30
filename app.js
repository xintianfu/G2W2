const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

// 截图预览配置
const snapshotPreview = document.getElementById("snapshotPreview");
const previewCtx = snapshotPreview.getContext("2d");
snapshotPreview.width = 512;
snapshotPreview.height = 512;

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// 核心状态变量
let isGrabbingLeft = false; 
let leftController = null;
let rightController = null;

let lastPinchTime = 0;
const pinchCooldownMs = 1500;

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

// ---------- 1. 截图与保存逻辑 ----------
function takeSnapshot() {
    if (!video.videoWidth || video.videoWidth < 100) return;
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);

    const vAspect = video.videoWidth / video.videoHeight;
    const tAspect = PANEL_TEX_WIDTH / PANEL_TEX_HEIGHT;
    let dW, dH, oX, oY;

    if (vAspect > tAspect) {
        dH = PANEL_TEX_HEIGHT; dW = dH * vAspect;
        oX = (PANEL_TEX_WIDTH - dW) / 2; oY = 0;
    } else {
        dW = PANEL_TEX_WIDTH; dH = dW / vAspect;
        oX = 0; oY = (PANEL_TEX_HEIGHT - dH) / 2;
    }

    ctx.save();
    ctx.translate(PANEL_TEX_WIDTH / 2, PANEL_TEX_HEIGHT / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_WIDTH / 2, -PANEL_TEX_HEIGHT / 2);
    ctx.drawImage(video, oX, oY, dW, dH);
    ctx.restore();

    snapshotTexture.update();
    
    // 面板出现在眼前
    const cam = xrHelper.baseExperience.camera;
    const forward = cam.getForwardRay(1).direction;
    snapshotPanel.position = cam.globalPosition.add(forward.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    // 自动保存到 Quest
    try {
        const dataURL = snapshotTexture.getContext().canvas.toDataURL("image/jpeg", 0.9);
        const link = document.createElement("a");
        link.href = dataURL;
        link.download = `Shot_${Date.now()}.jpg`;
        link.click();
    } catch(e) { console.error(e); }
}

// ---------- 2. 交互循环 (核心修复：物理跟随) ----------
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    // 如果左手正在抓取 (Pinch 住不放)
    if (isGrabbingLeft && leftController) {
        // 在控制器模式下，面板位置 = 射线的起点
        const grabPos = leftController.pointer.position;
        snapshotPanel.setAbsolutePosition(grabPos);
        
        // 面板始终面向用户，且保持正向
        snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
    }
}

// ---------- 3. 绘画逻辑过滤 ----------
function setupPointerLogic() {
    scene.onPointerObservable.add((pointerInfo) => {
        // 屏蔽左手绘画
        if (xrHelper && xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
            const context = xrHelper.pointerSelection.getPointerContext(pointerInfo.event.pointerId);
            if (context?.inputSource?.handedness === "left") return;
        }

        const type = pointerInfo.type;
        const pickInfo = pointerInfo.pickInfo;
        const isHit = pickInfo?.hit && pickInfo.pickedMesh === snapshotPanel;
        const uv = isHit ? pickInfo.getTextureCoordinates() : null;

        if (type === BABYLON.PointerEventTypes.POINTERDOWN && uv) {
            drawAtUV(uv, true);
        } else if (type === BABYLON.PointerEventTypes.POINTERMOVE && uv) {
            drawAtUV(uv, false);
        }
    });
}

function drawAtUV(uv, isFirst) {
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); 
    const x = (1 - uv.x) * PANEL_TEX_WIDTH;
    const y = (1 - uv.y) * PANEL_TEX_HEIGHT; 
    ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = 10; ctx.lineCap = "round";
    if (isFirst) {
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ff3b30"; ctx.fill();
    } else {
        // 简化连续线逻辑
        ctx.lineTo(x, y); ctx.stroke();
    }
    snapshotTexture.update();
}

// ---------- 4. XR 初始化 (事件驱动模式) ----------
async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });

        xrHelper.input.onControllerAddedObservable.add((input) => {
            const side = input.inputSource.handedness;
            
            if (side === "left") {
                leftController = input;
                
                // 监听捏合按下 (Select 触发)
                input.onSelectTriggeredObservable.add(() => {
                    // 发射一条射线检测是否指着面板
                    const ray = input.getWorldPointerRay();
                    const pick = scene.pickWithRay(ray);
                    
                    if (pick.hit && pick.pickedMesh === snapshotPanel) {
                        isGrabbingLeft = true;
                        // 抓住变色反馈：蓝色
                        snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.6, 1);
                        setStatus("左手抓取中...");
                    }
                });

                // 监听捏合松开 (Select 退出)
                input.onSelectExitedObservable.add(() => {
                    if (isGrabbingLeft) {
                        isGrabbingLeft = false;
                        snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
                        setStatus("左手已放开");
                    }
                });
            } else if (side === "right") {
                rightController = input;
                
                // 右手 Pinch 截图
                input.onSelectTriggeredObservable.add(() => {
                    if (nowMs() - lastPinchTime > pinchCooldownMs) {
                        lastPinchTime = nowMs();
                        takeSnapshot();
                        setStatus("右手：截图成功");
                    }
                });
            }
        });
        
        setStatus("XR 就绪，请点击按钮进入 AR");
    } catch (e) { setStatus("XR 启动失败"); }
}

// ---------- 5. 主程序入口 ----------
async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    // 面板初始化
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

    // 启动摄像头
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        await video.play();
    } catch(e) { setStatus("摄像头开启失败"); }

    await initXR();

    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });
}

bootstrap();