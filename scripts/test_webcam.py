import cv2
import argparse
from ultralytics import YOLO

def main():
    parser = argparse.ArgumentParser(description="Test YOLO plate detector with PC webcam.")
    parser.add_argument("--weights", type=str, default="runs/detector/full/weights/last.pt", help="Path to YOLO weights")
    parser.add_argument("--camera", type=int, default=0, help="Camera index (default 0)")
    args = parser.parse_args()

    print(f"Loading model from {args.weights}...")
    try:
        model = YOLO(args.weights)
    except Exception as e:
        print(f"Error loading model: {e}")
        print("Please check the path. If training just started, 'last.pt' might not exist yet.")
        return

    print("Opening webcam...")
    cap = cv2.VideoCapture(args.camera)
    
    if not cap.isOpened():
        print("Error: Could not open webcam.")
        return

    print("Webcam started. Press 'q' to quit.")

    while True:
        ret, frame = cap.read()
        if not ret:
            print("Failed to grab frame.")
            break
            
        # Run YOLO inference
        results = model.predict(frame, conf=0.25, verbose=False)
        
        # Draw bounding boxes
        annotated_frame = results[0].plot()

        # Display the frame
        cv2.imshow("YOLO Plate Detection (Press 'q' to quit)", annotated_frame)

        # Break the loop on 'q' key press
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
