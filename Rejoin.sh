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
ALL_PACKAGES=($(pm list packages | grep -E "com.roblox.client|com.roblox.clien[a-z]" | cut -d ":" -f2 | sort))

if [ ${#ALL_PACKAGES[@]} -eq 0 ]; then
    echo -e "${B_Red}[!] Tidak ada aplikasi Roblox ditemukan!${NC}"
    exit 1
fi

echo -e "Ditemukan ${#ALL_PACKAGES[@]} aplikasi."
echo -e "1) Jalankan SEMUA sekaligus"
echo -e "2) Pilih satu saja"
read -p "Pilihan (1-2): " RUN_MODE

TARGET_PACKAGES=()
[[ "$RUN_MODE" == "1" ]] && TARGET_PACKAGES=("${ALL_PACKAGES[@]}") || {
    echo -e "\nPilih nomor aplikasi:"
    for i in "${!ALL_PACKAGES[@]}"; do echo -e "  $((i+1)) ${ALL_PACKAGES[$i]}"; done
    read -p "Nomor: " CHOSEN
    TARGET_PACKAGES=("${ALL_PACKAGES[$((CHOSEN-1))]}")
}

read -p "Masukkan Link Private Server (Kosongkan jika Publik): " PRIV_LINK
if [[ -z "$PRIV_LINK" ]]; then
    read -p "Masukkan Game ID: " GAME_ID
    IS_PRIVATE=false
else
    GAME_ID=$(echo $PRIV_LINK | grep -oP 'games/\K[0-9]+')
    CODE=$(echo $PRIV_LINK | grep -oP 'privateServerLinkCode=\K[a-zA-Z0-9_-]+')
    IS_PRIVATE=true
fi

# --- PAKSA LANDSCAPE ---
su -c "settings put system accelerometer_rotation 0"
su -c "settings put system user_rotation 1"

# --- POSISI WINDOW ---
WIDTH=520
HEIGHT=360
POS_Y=100

rejoin_and_align() {
    local PKG=$1
    local INDEX=$2
    local POS_X=$(( INDEX * 540 ))
    local END_X=$(( POS_X + WIDTH ))
    local END_Y=$(( POS_Y + HEIGHT ))

    echo -e "[$(date +%T)] ${B_Yellow}LAUNCHING${NC} - $PKG..."
    
    su -c "am force-stop $PKG"
    sleep 1

    [[ "$IS_PRIVATE" == "true" ]] && D_LINK="roblox://placeId=$GAME_ID&linkCode=$CODE" || D_LINK="roblox://placeId=$GAME_ID"

    # LANGKAH 1: Buka Fullscreen dulu biar PASTI MUNCUL
    su -c "am start -a android.intent.action.VIEW -d '$D_LINK' $PKG" > /dev/null 2>&1
    
    # Tunggu 5 detik sampai aplikasi benar-benar nongol di layar
    sleep 5

    # LANGKAH 2: Cari ID Jendela (Task ID)
    local TASK_ID=$(su -c "dumpsys activity activities | grep -B 1 $PKG | grep 'TaskRecord' | head -n 1 | grep -oP ' #\K[0-9]+'")
    
    if [ -z "$TASK_ID" ]; then
        TASK_ID=$(su -c "am stack list | grep $PKG | grep -oP 'taskId=\K[0-9]+' | head -n 1")
    fi

    # LANGKAH 3: Paksa jadi melayang dan geser ke posisi X
    if [ ! -z "$TASK_ID" ]; then
        echo -e "[$(date +%T)] ${B_Green}FIXING WINDOW${NC} - Task ID: $TASK_ID ke X:$POS_X"
        su -c "am stack move-task $TASK_ID 5 true" > /dev/null 2>&1
        su -c "am resize-task $TASK_ID $POS_X $POS_Y $END_X $END_Y" > /dev/null 2>&1
    else
        echo -e "${B_Red}[!] Gagal resize, mencoba paksa ulang...${NC}"
        su -c "am start -n $PKG/com.roblox.client.MainActivity --windowingMode 5 --task-bounds $POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1
    fi
}

while true; do
    for idx in "${!TARGET_PACKAGES[@]}"; do
        CURRENT_PKG="${TARGET_PACKAGES[$idx]}"
        IS_RUNNING=$(su -c "pidof $CURRENT_PKG")
        if [ -z "$IS_RUNNING" ]; then
            rejoin_and_align "$CURRENT_PKG" "$idx"
        fi
    done
    sleep 15
done
