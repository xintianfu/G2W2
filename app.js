import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.160.0/examples/jsm/webxr/ARButton.js';

// --- 全局变量 ---
let scene, camera, renderer, video, texture;
let snapshotMesh, canvas, ctx;
let handLeft, handRight;

let isGrabbing = false;      // 左手搬运状态
let isDrawing = false;      // 右手绘画状态
let lastPinchTime = 0;      // 截图冷却

const PANEL_WIDTH = 0.42;    // 面板物理宽度 (米)
const PANEL_HEIGHT = 0.28;   // 面板物理高度 (米)
const CANV_SIZE = 1024;      // 纹理分辨率

const statusEl = document.getElementById('status');
function setStatus(msg) { if(statusEl) statusEl.innerText = "Status: " + msg; }

// --- 初始化 ---
async function init() {
    // 1. 场景基础
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);

    // 2. AR 按钮 (开启手部追踪)
    document.body.appendChild(ARButton.createButton(renderer, { 
        optionalFeatures: ['hand-tracking'] 
    }));

    // 3. 摄像头准备
    video = document.getElementById('cameraVideo');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'environment', width: 1280, height: 720 } 
        });
        video.srcObject = stream;
        video.play();
    } catch (e) { setStatus("Camera Error"); }

    // 4. 截图面板 (Canvas 纹理)
    canvas = document.createElement('canvas');
    canvas.width = CANV_SIZE;
    canvas.height = CANV_SIZE;
    ctx = canvas.getContext('2d');
    
    // 初始化 Canvas 背景为透明
    ctx.clearRect(0, 0, CANV_SIZE, CANV_SIZE);

    texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({ 
        map: texture, 
        side: THREE.DoubleSide, 
        transparent: true,
        depthTest: true
    });
    
    snapshotMesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT), material);
    snapshotMesh.visible = false; // 初始隐藏
    scene.add(snapshotMesh);

    // 5. 手部对象初始化 (WebXR 控制器)
    handLeft = renderer.xr.getHand(0);
    handRight = renderer.xr.getHand(1);
    scene.add(handLeft);
    scene.add(handRight);

    renderer.setAnimationLoop(renderLoop);
    setStatus("Ready. Enter AR.");
}

// --- 核心交互逻辑 ---
function handleInteractions() {
    const session = renderer.xr.getSession();
    if (!session) return;

    // 遍历所有输入源以区分左右手
    const inputSources = session.inputSources;
    for (let i = 0; i < inputSources.length; i++) {
        const inputSource = inputSources[i];
        if (!inputSource.hand) continue;

        const handedness = inputSource.handedness;
        const hand = (handedness === 'left') ? handLeft : handRight;
        
        // 获取关键关节点
        const thumbTip = hand.joints['thumb-tip'];
        const indexTip = hand.joints['index-finger-tip'];
        if (!thumbTip || !indexTip) continue;

        // 计算指尖捏合距离
        const dist = thumbTip.position.distanceTo(indexTip.position);
        const isPinching = dist < 0.035;

        // --- 右手逻辑：截图与绘画 ---
        if (handedness === 'right') {
            // 1. Pinch 截图 (冷却时间 2秒)
            if (isPinching && performance.now() - lastPinchTime > 2000) {
                takeSnapshot();
                lastPinchTime = performance.now();
            }
            // 2. 食指尖绘画 (即碰即画)
            checkDrawing(indexTip.position);
        } 
        
        // --- 左手逻辑：搬运面板 ---
        else if (handedness === 'left') {
            if (isPinching) {
                const pinchPos = indexTip.position;
                // 如果还没抓住，先检测距离
                if (!isGrabbing) {
                    const dToPanel = pinchPos.distanceTo(snapshotMesh.position);
                    if (dToPanel < 0.3) { // 30cm 内感应抓取
                        isGrabbing = true;
                    }
                }
                // 抓取中：强行同步位置与旋转
                if (isGrabbing) {
                    snapshotMesh.position.copy(pinchPos);
                    // 解决移动反向：面板看向相机
                    snapshotMesh.lookAt(camera.position);
                }
            } else {
                isGrabbing = false;
            }
        }
    }
}

// --- 绘画检测逻辑 (右手专用) ---
function checkDrawing(fingerWorldPos) {
    if (!snapshotMesh.visible) return;

    // 转换指尖世界坐标到面板本地空间
    const localPos = snapshotMesh.worldToLocal(fingerWorldPos.clone());
    
    // 判定范围 (PlaneGeometry 默认在 XY 平面，范围从 -width/2 到 width/2)
    const normalizedX = localPos.x / (PANEL_WIDTH / 2);  // 范围 -1 到 1
    const normalizedY = localPos.y / (PANEL_HEIGHT / 2); // 范围 -1 到 1

    // 检查是否触碰到表面 (距离 Z 轴 3cm 内)
    if (Math.abs(normalizedX) < 1 && Math.abs(normalizedY) < 1 && Math.abs(localPos.z) < 0.03) {
        // 映射到 Canvas 坐标 (0 到 1024)
        const canvasX = (normalizedX + 1) * (CANV_SIZE / 2);
        const canvasY = (1 - normalizedY) * (CANV_SIZE / 2); // Canvas Y轴向上反转

        ctx.strokeStyle = "red";
        ctx.lineWidth = 12;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        if (!isDrawing) {
            ctx.beginPath();
            ctx.moveTo(canvasX, canvasY);
            isDrawing = true;
        } else {
            ctx.lineTo(canvasX, canvasY);
            ctx.stroke();
        }
        texture.needsUpdate = true;
    } else {
        isDrawing = false; // 离开面板表面
    }
}

// --- 截图功能 ---
function takeSnapshot() {
    if (!video.videoWidth) return;
    
    // 1. 清空并绘制视频帧 (水平镜像修正)
    ctx.save();
    ctx.clearRect(0, 0, CANV_SIZE, CANV_SIZE);
    ctx.translate(CANV_SIZE, 0);
    ctx.scale(-1, 1); // 解决左右反转
    
    // 保持比例绘制
    ctx.drawImage(video, 0, 0, CANV_SIZE, CANV_SIZE);
    ctx.restore();
    texture.needsUpdate = true;

    // 2. 将面板重置到相机前方 0.6 米处
    const offset = new THREE.Vector3(0, 0, -0.6).applyQuaternion(camera.quaternion);
    snapshotMesh.position.copy(camera.position).add(offset);
    snapshotMesh.lookAt(camera.position);
    snapshotMesh.visible = true;

    // 3. 自动保存到本地
    const link = document.createElement('a');
    link.download = `Snapshot_${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    
    setStatus("Captured & Saved!");
}

// --- 渲染循环 ---
function renderLoop() {
    handleInteractions();
    renderer.render(scene, camera);
}

// 窗口调整
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// 启动
init();