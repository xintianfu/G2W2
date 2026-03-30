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

// 【关键变量】记录上一帧左手的位置，用于计算移动增量
let lastLeftHandPos = null; 

// 判定阈值 (米)
const PINCH_THRESHOLD = 0.04;  // 4cm
const COOLDOWN = 1500;         // 截图冷却

const PANEL_TEX_SIZE = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
    console.log(text);
}

// ---------- 1. 核心算法：获取关节世界位置 (带坐标保底) ----------
function getHandPoint(controller, jointName) {
    if (controller?.inputSource?.hand) {
        const joint = controller.inputSource.hand.get(jointName);
        const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
        const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
        if (frame && joint && ref) {
            const pose = frame.getJointPose(joint, ref);
            if (pose) {
                // 返回世界坐标系下的 Vector3
                return new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
            }
        }
    }
    // 如果没有骨骼数据，克隆控制器的 pointer 位置作为保底
    return controller.pointer.position.clone();
}

// ---------- 2. 核心循环：实时物理位移判定交互 ----------
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    xrHelper.input.controllers.forEach((controller) => {
        const side = controller.inputSource.handedness;

        // 获取该手的拇指和食指坐标
        const thumb = getHandPoint(controller, "thumb-tip");
        const index = getHandPoint(controller, "index-finger-tip");
        
        if (!thumb || !index) return;

        const dist = BABYLON.Vector3.Distance(thumb, index);
        const isPinching = dist < PINCH_THRESHOLD;
        const currentPinchPos = BABYLON.Vector3.Center(thumb, index);

        // --- 左手：位移增量算法 (解决反向移动) ---
        if (side === "left") {
            if (isPinching && snapshotPanel.isEnabled()) {
                if (!isGrabbingLeft) {
                    isGrabbingLeft = true;
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.7, 1); // 变蓝反馈
                    setStatus("左手抓取：已吸附");
                    
                    // 初始瞬间，面板中心对齐当前手部位置
                    snapshotPanel.setAbsolutePosition(currentPinchPos);
                } else {
                    // 【修正反向的核心逻辑】
                    // 1. 如果记录了上一帧的位置，计算本帧手移动的矢量方向
                    if (lastLeftHandPos) {
                        const moveVector = currentPinchPos.subtract(lastLeftHandPos);
                        // 2. 将这个矢量物理地叠加到面板的位置上
                        snapshotPanel.position.addInPlace(moveVector);
                    }
                }
                // 更新上一帧位置记录
                lastLeftHandPos = currentPinchPos.clone();
                
                // 每一帧都让面板正面看向相机
                snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
            } else {
                if (isGrabbingLeft) {
                    isGrabbingLeft = false;
                    lastLeftHandPos = null; // 重置记录
                    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1); // 恢复白色
                    setStatus("左手释放");
                }
            }
        } 
        
        // --- 右手：Pinch 截图 (保持稳定) ---
        else if (side === "right") {
            if (isPinching && !wasPinchingRight) {
                if (performance.now() - lastPinchTime > COOLDOWN) {
                    lastPinchTime = performance.now();
                    takeSnapshot();
                    setStatus("右手快照成功");
                }
            }
            wasPinchingRight = isPinching;
        }
    });
}

// ---------- 3. 截图功能 (带镜像修正) ----------
function takeSnapshot() {
    if (!video.videoWidth) return;
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    
    // 镜像绘制修正
    ctx.save();
    ctx.translate(PANEL_TEX_SIZE / 2, PANEL_TEX_SIZE / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_SIZE / 2, -PANEL_TEX_SIZE / 2);
    ctx.drawImage(video, 0, 0, PANEL_TEX_SIZE, PANEL_TEX_SIZE);
    ctx.restore();
    
    snapshotTexture.update();
    
    // 面板出现在相机前方 0.5 米
    const cam = xrHelper.baseExperience.camera;
    const offset = cam.getForwardRay(1).direction.scale(0.5);
    snapshotPanel.position = cam.globalPosition.add(offset);
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    // 自动触发浏览器保存
    try {
        const dataURL = snapshotTexture.getContext().canvas.toDataURL("image/jpeg", 0.9);
        const link = document.createElement("a");
        link.href = dataURL;
        link.download = `Quest_AR_${Date.now()}.jpg`;
        link.click();
    } catch (e) { console.warn("Save Error:", e); }
}

// ---------- 4. XR 与引擎启动流程 ----------
async function initXR() {
    try {
        xrHelper = await scene.createDefaultXRExperienceAsync({
            uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
        });
        
        // 显式开启手势追踪
        xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
            xrInput: xrHelper.input
        });
        
        setStatus("XR Ready. 请进入 AR。");
    } catch (e) {
        setStatus("XR 启动失败，请检查浏览器设置或 HTTPS。");
    }
}

async function bootstrap() {
    // 1. 初始化 Babylon 引擎
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    // 2. 创建截图面板
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
    snapshotMaterial.disableLighting = true; // 让面板自发光不受阴影影响
    snapshotPanel.material = snapshotMaterial;
    snapshotPanel.setEnabled(false);

    // 3. 启动摄像头流
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment", width: 1280, height: 720 } 
        });
        video.srcObject = stream;
        await video.play();
        setStatus("摄像头已连接");
    } catch (e) { 
        setStatus("请授权摄像头访问权限并确保 HTTPS"); 
    }

    // 4. 初始化 XR
    await initXR();
    
    // 5. 渲染循环
    engine.runRenderLoop(() => {
        updateLoop();
        scene.render();
    });

    // 处理窗口缩放
    window.addEventListener("resize", () => engine.resize());
}

bootstrap();