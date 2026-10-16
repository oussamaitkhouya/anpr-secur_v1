import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from ultralytics import YOLO

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load model globally
model = None

@app.on_event("startup")
def startup_event():
    global model
    print("Loading YOLO weights for detect_server...")
    try:
        model = YOLO("runs/detector/full/weights/last.pt")
        print("Model loaded successfully.")
    except Exception as e:
        print(f"Error loading model: {e}")

@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    if model is None:
        return {"detected": False, "error": "Model not loaded"}
        
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if img is None:
        return {"detected": False, "error": "Invalid image"}
        
    # Run YOLO inference
    results = model.predict(img, conf=0.25, verbose=False)
    
    # Check if any bounding box was found
    detected = len(results[0].boxes) > 0
    
    return {"detected": detected, "boxes": len(results[0].boxes)}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8001)
