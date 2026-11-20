# 🦷 DentB &bull; Autonomous WhatsApp Gateway (Google Compute Engine)

> **100% Free &bull; Unlimited Dispatches &bull; Zero Doctor Clicks**
> 
> Production deployment guide for hosting the DentB WhatsApp Web Gateway microservice on **Google Compute Engine (GCE)** with Docker and Baileys.

---

## 🌟 Why Google Compute Engine (GCE)?

- **100% Free Tier Eligible:** Runs permanently under Google Cloud's **Always Free** tier (`e2-micro`, 1GB RAM, 30GB disk = **$0.00 / month forever**).
- **Persistent WebSocket Session:** Unlike Cloud Run (which spins down containers or multi-instantiates, killing WhatsApp Web sessions), GCE keeps a continuous, single-session WebSocket open 24/7/365.
- **Anti-Ban FIFO Queue:** Built-in queue with human-like jitter (1.4s - 2.3s) ensures that even if you send 500+ appointment reminders in a single morning, WhatsApp delivers each message safely without rate-limiting or number flagging.
- **Universal Access:** Operatory desktop PCs, chairside Android tablets, and front-desk reception can all share the same cloud gateway URL simultaneously.

---

## 🚀 Fast 3-Minute Deployment on Google Cloud

### Method A: Via Google Cloud Console (Visual Web UI)

1. **Open Google Cloud Console:**
   - Go to [Google Cloud Console - Compute Engine](https://console.cloud.google.com/compute/instances).
   - Select your project: `dentos-4ac00` (or your active GCP project).

2. **Click "Create Instance":**
   - **Name:** `dentb-whatsapp-gateway`
   - **Region:** `us-central1` (Iowa) or `asia-south1` (Mumbai)
     > *Tip: `us-central1`, `us-west1`, or `us-east1` are eligible for Google Cloud's Always Free Tier!*
   - **Machine Configuration:**
     - Series: `E2`
     - Machine Type: `e2-micro` (2 vCPU, 1 GB memory)
   - **Boot Disk:**
     - OS: `Ubuntu`
     - Version: `Ubuntu 22.04 LTS` (x86/64)
     - Size: `10 GB` (Standard persistent disk)
   - **Firewall:**
     - ☑️ **Allow HTTP traffic**
     - ☑️ **Allow HTTPS traffic**

3. **Allow Port 5055 in GCP Firewall (Optional, but Port 80 works out of the box!):**
   - In GCP Console, go to **VPC network** &rarr; **Firewall** &rarr; **Create Firewall Rule**:
     - Name: `allow-dentb-gateway`
     - Targets: `All instances in the network`
     - Source IPv4 ranges: `0.0.0.0/0`
     - Protocols and ports: Specified protocols &rarr; TCP &rarr; `5055`
   - *(Note: Port 80 is already open by default if you checked "Allow HTTP traffic".)*

4. **Click "Create"** and wait ~30 seconds for the green checkmark.

5. **Click the "SSH" button** next to your VM instance and paste this **1 single command**:
   ```bash
   curl -sSL https://raw.githubusercontent.com/VNIKHIL0/dentb/main/gateway/setup-gce.sh | bash
   ```

---

### Method B: Via `gcloud` CLI (1 Command)

If you have `gcloud` installed locally, run:

```bash
gcloud compute instances create dentb-whatsapp-gateway \
    --project=dentos-4ac00 \
    --zone=us-central1-a \
    --machine-type=e2-micro \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=10GB \
    --tags=http-server,https-server \
    --metadata=startup-script='curl -sSL https://raw.githubusercontent.com/VNIKHIL0/dentb/main/gateway/setup-gce.sh | bash'
```

---

## 📱 Linking WhatsApp to DentB

1. Once the script finishes, it will print your Cloud URL:
   ```
   Cloud Endpoint URL: http://<YOUR_VM_EXTERNAL_IP>:5055
   (or http://<YOUR_VM_EXTERNAL_IP>)
   ```
2. Open **DentB** (Windows or Android) &rarr; **Automations**.
3. Click **"Connect Clinic WhatsApp"**.
4. In **Gateway Server Settings**, paste your Cloud URL:
   `http://<YOUR_VM_EXTERNAL_IP>:5055`
5. The live QR code appears immediately on screen.
6. Open WhatsApp on your clinic mobile phone &rarr; **Linked Devices** &rarr; **Link a Device** &rarr; scan the QR code!
7. The dialog updates to **🟢 Clinic WhatsApp is Connected!** with your clinic phone number.

You are done! All patient appointment confirmations, 24-hour reminders, and recalls will now be dispatched automatically 24/7 with **0 doctor interaction**!
