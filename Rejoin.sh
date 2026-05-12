#!/bin/bash

# --- WARNA ---
B_Green='\033[1;32m'
B_Cyan='\033[1;36m'
B_Yellow='\033[1;33m'
B_Red='\033[1;31m'
NC='\033[0m'

clear
echo -e "${B_Cyan}=======================================${NC}"
echo -e "${B_Green}    MULTI-ACCOUNT WINDOW MANAGER PRO   ${NC}"
echo -e "${B_Cyan}=======================================${NC}"

# --- INPUT CONFIG ---
echo -e "${B_Yellow}[1] Konfigurasi Aplikasi${NC}"
read -p "Masukkan Nama Package (contoh: com.roblox.client): " PKG
read -p "Masukkan Link Private Server: " PRIV_LINK

echo -e "\n${B_Yellow}[2] Konfigurasi Tata Letak (Layout)${NC}"
read -p "Koordinat X (Posisi Kiri/Kanan): " POS_X
read -p "Koordinat Y (Posisi Atas/Bawah): " POS_Y
read -p "Lebar Jendela: " WIDTH
read -p "Tinggi Jendela: " HEIGHT

# Ekstraksi Data Game
GAME_ID=$(echo $PRIV_LINK | grep -oP 'games/\K[0-9]+')
CODE=$(echo $PRIV_LINK | grep -oP 'privateServerLinkCode=\K[a-zA-Z0-9_-]+')

# Hitung koordinat batas
END_X=$((POS_X + WIDTH))
END_Y=$((POS_Y + HEIGHT))

if [[ -z "$GAME_ID" || -z "$PKG" ]]; then
    echo -e "${B_Red}[!] Data tidak lengkap. Pastikan Package dan Link benar.${NC}"
    exit 1
fi

rejoin_and_align() {
    echo -e "\n[$(date +%T)] ${B_Red}OFFLINE${NC} - Restarting $PKG..."
    
    # Force stop target package
    tsudo am force-stop $PKG
    sleep 1

    # Buka dengan mode Freeform dan Bounds spesifik
    # --windowingMode 5 = Freeform
    tsudo am start -a android.intent.action.VIEW \
        -d "roblox://placeId=$GAME_ID&linkCode=$CODE" \
        -n "$PKG/com.roblox.client.MainActivity" \
        --windowingMode 5 \
        --task-bounds "$POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1

    echo -e "[$(date +%T)] ${B_Green}RELAUNCHED${NC} at [$POS_X, $POS_Y]"
    sleep 30
}

# --- MAIN LOOP ---
echo -e "\n${B_Cyan}[*] Monitoring $PKG...${NC}"

while true; do
    IS_RUNNING=$(tsudo pidof $PKG)
    
    if [ -z "$IS_RUNNING" ]; then
        rejoin_and_align
    else
        # Tampilan status satu baris agar rapi
        echo -ne "\r[$(date +%T)] ${B_Green}RUNNING${NC}: $PKG | Pos: $POS_X,$POS_Y    "
        sleep 20
    fi
done
