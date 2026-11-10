# 🔬 UIC Research Record Portal

A department research record portal for tracking faculty profiles, publication counts, and custom ROS scores.

---

## 🌐 Running on Localhost

The server is currently running live on:

👉 **[http://localhost:3000](http://localhost:3000)**

To run or restart the server manually at any time:
```powershell
cd "C:\Users\sachi\.gemini\antigravity\scratch\uic-research-portal"
& "C:\Program Files\nodejs\node.exe" server.js
```

---

## ⚙️ Key Details & ROS Customization

### 1. No Pre-defined Formula
- **No weights or calculations** are applied to publications or ROS.
- You directly input the **ROS points (0.00 to 1.00)** for every faculty member.
- You can enter the value via direct text input or adjust it with the slider.

### 2. Faculty Profile Record
- **Photo**: Upload image (preview shown before saving)
- **Full Name**: Faculty member's name
- **Employee Code**: Unique identifier
- **Designation & Department**: Academic title and department

### 3. Publication Records Tracked
- **Journal Q1**
- **Journal Q2**
- **Journal Q3**
- **Journal Q4**
- **Conference Papers**
- **Book Chapters**
- **Patents**

### 4. ROS Filter on Dashboard
- **All Faculty**
- **Zero ROS / No Publications (0.00)**: Instantly isolates faculty with 0 ROS
- **Low ROS (< 0.3)**
- **Moderate ROS (0.3 - 0.6)**
- **Good ROS (> 0.6)**
- **Search bar**: Filter by name or employee code in real time
