#!/bin/bash

# --- KONFIGURASI WARNA ---
B_Green='\033[1;32m'
B_Cyan='\033[1;36m'
B_Yellow='\033[1;33m'
B_Red='\033[1;31m'
NC='\033[0m'

clear
echo -e "${B_Cyan}=======================================${NC}"
echo -e "${B_Green}   ROBLOX MULTI-AUTOMATION LANDSCAPE   ${NC}"
echo -e "${B_Cyan}=======================================${NC}"

# --- AUTO DETECT SEMUA PACKAGE ---
echo -e "${B_Yellow}[1] Memindai semua clone com.roblox.clien*...${NC}"
ALL_PACKAGES=($(pm list packages | grep -E "com.roblox.client|com.roblox.clien[a-z]" | cut -d ":" -f2 | sort))

if [ ${#ALL_PACKAGES[@]} -eq 0 ]; then
    echo -e "${B_Red}[!] Tidak ada aplikasi Roblox/clone ditemukan!${NC}"
    exit 1
fi

echo -e "Ditemukan ${#ALL_PACKAGES[@]} aplikasi."
echo -e "1) Jalankan SEMUA aplikasi sekaligus"
echo -e "2) Pilih satu aplikasi saja"
read -p "Pilihan kamu (1-2): " RUN_MODE

TARGET_PACKAGES=()
if [ "$RUN_MODE" == "1" ]; then
    TARGET_PACKAGES=("${ALL_PACKAGES[@]}")
else
    echo -e "\nPilih aplikasi:"
    for i in "${!ALL_PACKAGES[@]}"; do
        echo -e "  $((i+1)) ${ALL_PACKAGES[$i]}"
    done
    read -p "Masukkan nomor: " CHOSEN
    TARGET_PACKAGES=("${ALL_PACKAGES[$((CHOSEN-1))]}")
fi

# --- INPUT LINK SERVER ---
echo -e "\n${B_Yellow}[2] Informasi Server Game${NC}"
read -p "Masukkan Link Private Server (Kosongkan jika Publik): " PRIV_LINK

if [[ -z "$PRIV_LINK" ]]; then
    read -p "Masukkan Game ID (Place ID) Roblox: " GAME_ID
    IS_PRIVATE=false
else
    GAME_ID=$(echo $PRIV_LINK | grep -oP 'games/\K[0-9]+')
    CODE=$(echo $PRIV_LINK | grep -oP 'privateServerLinkCode=\K[a-zA-Z0-9_-]+')
    IS_PRIVATE=true
fi

# --- UKURAN JENDELA LANDSCAPE ---
WIDTH=520    
HEIGHT=360   
POS_Y=100     

rejoin_and_align() {
    local PKG=$1
    local INDEX=$2
    
    local POS_X=$(( INDEX * 540 ))
    local END_X=$(( POS_X + WIDTH ))
    local END_Y=$(( POS_Y + HEIGHT ))

    echo -e "[$(date +%T)] ${B_Yellow}LAUNCHING${NC} - Membuka $PKG..."
    
    # Memakai su -c langsung (Universal Root untuk Cloud Phone)
    su -c am force-stop $PKG
    sleep 1

    if [ "$IS_PRIVATE" = true ]; then
        su -c am start -a android.intent.action.VIEW -d "roblox://placeId=$GAME_ID&linkCode=$CODE" > /dev/null 2>&1
    else
        su -c am start -a android.intent.action.VIEW -d "roblox://placeId=$GAME_ID" > /dev/null 2>&1
    fi
    
    sleep 4

    # Ambil Jendela Task ID via dumpsys standar Android 10
    local TASK_ID=$(su -c dumpsys activity activities | grep -B 1 "$PKG" | grep "TaskRecord" | head -n 1 | grep -oP ' #\K[0-9]+')
    
    if [ -z "$TASK_ID" ]; then
        TASK_ID=$(su -c am stack list | grep -B 1 "$PKG" | grep "taskId=" | head -n 1 | grep -oP 'taskId=\K[0-9]+')
    fi

    # Eksekusi pengecilan window mendatar
    if [ ! -z "$TASK_ID" ]; then
        echo -e "[$(date +%T)] ${B_Green}MOVING${NC} - Menata Jendela (Task ID: $TASK_ID) ke posisi X:$POS_X"
        su -c am stack move-task $TASK_ID 5 true > /dev/null 2>&1
        su -c am resize-task $TASK_ID $POS_X $POS_Y $END_X $END_Y > /dev/null 2>&1
    else
        echo -e "[$(date +%T)] ${B_Red}LAUNCH METHOD 2${NC} - Mengatur ulang posisi..."
        su -c am start -n "$PKG/com.roblox.client.MainActivity" --windowingMode 5 --task-bounds "$POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1
    fi
}

# --- MONITORING LOOP ---
echo -e "\n${B_Green}[+] Sistem Pemantau Multi-Window Aktif...${NC}"
echo -e "${B_Cyan}---------------------------------------${NC}"

while true; do
    for idx in "${!TARGET_PACKAGES[@]}"; do
        CURRENT_PKG="${TARGET_PACKAGES[$idx]}"
        
        IS_RUNNING=$(su -c pidof $CURRENT_PKG)
        
        if [ -z "$IS_RUNNING" ]; then
            rejoin_and_align "$CURRENT_PKG" "$idx"
            sleep 10 
        fi
    done
    sleep 10
done
EOF
