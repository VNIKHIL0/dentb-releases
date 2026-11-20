#!/usr/bin/env bash
set -e

# ==============================================================================
# DentB &bull; Autonomous WhatsApp Gateway &bull; 1-Click GCE Provisioner
# ==============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# clear screen only if interactive terminal
[ -t 1 ] && clear 2>/dev/null || true
echo -e "${CYAN}${BOLD}"
echo "  ================================================================"
echo "    🦷 DentB Autonomous WhatsApp Gateway &bull; Google Cloud GCE"
echo "    100% Free &bull; Unlimited Recalls &bull; 0 Doctor Clicks"
echo "  ================================================================"
echo -e "${NC}"

# 1. Require root / sudo
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}Notice: Elevating to root privileges with sudo...${NC}"
  exec sudo bash "$0" "$@"
fi

INSTALL_DIR="/opt/dentb-whatsapp-gateway"

echo -e "${CYAN}[1/5] Updating system packages and installing Docker...${NC}"
apt-get update -y > /dev/null 2>&1
apt-get install -y ca-certificates curl gnupg lsb-release git > /dev/null 2>&1

# Install Docker if not present
if ! command -v docker &> /dev/null; then
  echo -e "${CYAN}Installing Docker engine...${NC}"
  mkdir -m 0755 -p /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes > /dev/null 2>&1
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -y > /dev/null 2>&1
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin > /dev/null 2>&1
fi

systemctl enable docker > /dev/null 2>&1
systemctl start docker > /dev/null 2>&1

echo -e "${CYAN}[2/5] Setting up persistent workspace at ${INSTALL_DIR}...${NC}"
mkdir -p "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}/auth_session"
cd "${INSTALL_DIR}"

# Check if script is run locally from an existing repository clone
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
if [ -f "${SCRIPT_DIR}/server.js" ] && [ -f "${SCRIPT_DIR}/Dockerfile" ]; then
  echo -e "${CYAN}Copying local gateway files from ${SCRIPT_DIR}...${NC}"
  cp -r "${SCRIPT_DIR}/"* "${INSTALL_DIR}/"
else
  echo -e "${CYAN}Fetching latest DentB Gateway code from GitHub...${NC}"
  TMP_REPO="/tmp/dentb_clone_$(date +%s)"
  git clone --depth 1 https://github.com/VNIKHIL0/dentb-releases.git "${TMP_REPO}" > /dev/null 2>&1
  cp -r "${TMP_REPO}/gateway/"* "${INSTALL_DIR}/"
  rm -rf "${TMP_REPO}"
fi

echo -e "${CYAN}[3/5] Configuring firewall rules (Ports 5055 & 80)...${NC}"
if command -v ufw &> /dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 5055/tcp > /dev/null 2>&1 || true
  ufw allow 80/tcp > /dev/null 2>&1 || true
fi

echo -e "${CYAN}[4/5] Building and launching Docker container (Always-On)...${NC}"
docker compose down > /dev/null 2>&1 || true
docker compose up -d --build

echo -e "${CYAN}[5/5] Detecting VM Public IP...${NC}"
# Try GCP internal metadata server first (fastest on GCE)
PUBLIC_IP=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -s https://api.ipify.org 2>/dev/null || curl -s ifconfig.me 2>/dev/null || echo "YOUR_VM_EXTERNAL_IP")
fi

echo ""
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD} 🎉 DentB WhatsApp Gateway is LIVE & RUNNING 24/7!${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo ""
echo -e "  ${BOLD}Cloud Endpoint URL (Port 5055):${NC}  ${CYAN}http://${PUBLIC_IP}:5055${NC}"
echo -e "  ${BOLD}Cloud Endpoint URL (Port 80):${NC}    ${CYAN}http://${PUBLIC_IP}${NC}"
echo ""
echo -e "  ${BOLD}How to Link to DentB in 15 seconds:${NC}"
echo -e "  1. Open your ${BOLD}DentB${NC} Desktop app or Android tablet."
echo -e "  2. Go to ${BOLD}Automations${NC} &rarr; click ${BOLD}'Connect Clinic WhatsApp'${NC}."
echo -e "  3. In 'Gateway Server Settings', paste:"
echo -e "     ${YELLOW}http://${PUBLIC_IP}:5055${NC}  (or http://${PUBLIC_IP})"
echo -e "  4. Scan the QR code with your clinic WhatsApp phone (${BOLD}Linked Devices${NC})."
echo ""
echo -e "  ${BOLD}Container Management Commands:${NC}"
echo -e "  - View live logs:    ${CYAN}cd /opt/dentb-whatsapp-gateway && docker compose logs -f${NC}"
echo -e "  - Restart gateway:   ${CYAN}cd /opt/dentb-whatsapp-gateway && docker compose restart${NC}"
echo -e "  - Stop gateway:      ${CYAN}cd /opt/dentb-whatsapp-gateway && docker compose down${NC}"
echo ""
echo -e "${GREEN}DentB will now send all patient reminders, recalls, and invoices autonomously! 🚀${NC}"
echo ""
