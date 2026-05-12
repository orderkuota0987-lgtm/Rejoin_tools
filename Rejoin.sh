#!/bin/bash

# --- KONFIGURASI WARNA ---
B_Green='\033[1;32m'
B_Cyan='\033[1;36m'
B_Yellow='\033[1;33m'
B_Red='\033[1;31m'
NC='\033[0m'

clear
echo -e "${B_Cyan}=======================================${NC}"
echo -e "${B_Green}    MULTI-ACCOUNT AUTO-DETECT MANAGER  ${NC}"
echo -e "${B_Cyan}=======================================${NC}"

# --- AUTO DETECT PACKAGE ROBLOX (com.roblox.cliena - com.roblox.clienz) ---
echo -e "${B_Yellow}[1] Memindai Aplikasi com.roblox.clien[a-z]...${NC}"

# Menggunakan Regex untuk mencari package com.roblox.client ATAU com.roblox.clien[a-z]
PACKAGES=($(pm list packages | grep -E "com.roblox.client|com.roblox.clien[a-z]" | cut -d ":" -f2 | sort))

if [ ${#PACKAGES[@]} -eq 0 ]; then
    echo -e "${B_Red}[!] Tidak ada aplikasi com.roblox.clien* ditemukan!${NC}"
    echo -ne "${B_Yellow}Masukkan nama package manual sebagai alternatif: ${NC}"
    read PKG
else
    echo -e "Daftar aplikasi Roblox yang cocok:"
    for i in "${!PACKAGES[@]}"; do
        printf "${B_Cyan}%2d)${NC} %s\n" $((i+1)) "${PACKAGES[$i]}"
    done
    echo -e "${B_Cyan}---------------------------------------${NC}"
    read -p "Pilih nomor aplikasi (1-${#PACKAGES[@]}): " PKG_CHOICE
    
    # Validasi pilihan package
    if [[ $PKG_CHOICE -lt 1 || $PKG_CHOICE -gt ${#PACKAGES[@]} ]]; then
        echo -e "${B_Red}[!] Pilihan tidak valid!${NC}"
        exit 1
    fi
    PKG=${PACKAGES[$((PKG_CHOICE-1))]}
fi

echo -e "${B_Green}[+] Target terpilih: $PKG${NC}\n"

# --- INPUT DATA SERVER ---
echo -e "${B_Yellow}[2] Informasi Game & Server${NC}"
read -p "Masukkan Link Private Server (Kosongkan jika Publik): " PRIV_LINK

if [[ -z "$PRIV_LINK" ]]; then
    read -p "Masukkan Game ID (Place ID) Roblox: " GAME_ID
    IS_PRIVATE=false
else
    GAME_ID=$(echo $PRIV_LINK | grep -oP 'games/\K[0-9]+')
    CODE=$(echo $PRIV_LINK | grep -oP 'privateServerLinkCode=\K[a-zA-Z0-9_-]+')
    IS_PRIVATE=true
    
    if [[ -z "$GAME_ID" || -z "$CODE" ]]; then
        echo -e "${B_Red}[!] Link Private Server tidak valid!${NC}"
        exit 1
    fi
fi

if [[ -z "$GAME_ID" ]]; then
    echo -e "${B_Red}[!] Game ID wajib ada.${NC}"
    exit 1
fi

# --- PILIHAN SLOT LAYAR ---
echo -e "\n${B_Yellow}[3] Pilih Slot Barisan (Menyamping)${NC}"
echo -e "1) Akun 1 (Paling Kiri)"
echo -e "2) Akun 2 (Sebelah Akun 1)"
echo -e "3) Akun 3 (Sebelah Akun 2)"
echo -e "4) Akun 4 (Sebelah Akun 3)"
read -p "Pilihan slot (1-4): " SLOT

# --- OTOMATISASI LAYOUT MENYAMPING ---
WIDTH=360    
HEIGHT=800   
POS_Y=100    

case $SLOT in
    1) POS_X=0 ;;       
    2) POS_X=380 ;;     
    3) POS_X=760 ;;     
    4) POS_X=1140 ;;    
    *) echo -e "${B_Red}[!] Slot tidak valid!${NC}"; exit 1 ;;
esac

END_X=$((POS_X + WIDTH))
END_Y=$((POS_Y + HEIGHT))

rejoin_and_align() {
    echo -e "\n[$(date +%T)] ${B_Red}OFFLINE${NC} - Restarting $PKG..."
    
    tsudo am force-stop $PKG
    sleep 1

    if [ "$IS_PRIVATE" = true ]; then
        echo -e "[$(date +%T)] Menghubungkan ke Private Server..."
        DEEP_LINK="roblox://placeId=$GAME_ID&linkCode=$CODE"
    else
        echo -e "[$(date +%T)] Menghubungkan ke Public Server..."
        DEEP_LINK="roblox://placeId=$GAME_ID"
    fi

    tsudo am start -a android.intent.action.VIEW \
        -d "$DEEP_LINK" \
        -n "$PKG/com.roblox.client.MainActivity" \
        --windowingMode 5 \
        --task-bounds "$POS_X,$POS_Y,$END_X,$END_Y" > /dev/null 2>&1

    echo -e "[$(date +%T)] ${B_Green}RELAUNCHED${NC} di Barisan Ke-$SLOT"
    sleep 30
}

# --- MAIN LOOP ---
echo -e "\n${B_Cyan}[*] Monitoring $PKG di Slot Barisan $SLOT...${NC}"

while true; do
    IS_RUNNING=$(tsudo pidof $PKG)
    
    if [ -z "$IS_RUNNING" ]; then
        rejoin_and_align
    else
        echo -ne "\r[$(date +%T)] ${B_Green}RUNNING${NC}: $PKG | Barisan: $SLOT    "
        sleep 20
    fi
done
    IS_RUNNING=$(tsudo pidof $PKG)
    
    if [ -z "$IS_RUNNING" ]; then
        rejoin_and_align
    else
        # Tampilan status satu baris agar rapi
        echo -ne "\r[$(date +%T)] ${B_Green}RUNNING${NC}: $PKG | Pos: $POS_X,$POS_Y    "
        sleep 20
    fi
done
