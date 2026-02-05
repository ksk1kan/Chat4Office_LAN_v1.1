# Chat4Office (LAN Web Uygulaması) v1.1

Bu sürümde:
- ✅ DM okundu bilgisi + okunmayan sayaç
- ✅ Not/hatırlatma okundu bilgisi
- ✅ "Bitir" yapan kişi kapatır + kim bitirdiği loglanır
- ✅ Not silme: sadece oluşturan kişi + admin
- ✅ “data/db.json repo’ya konmaz. İlk kurulumda db.sample.json’u kopyalayıp db.json yapın.” gibi.

## Kurulum (Windows)
PowerShell'de `npm` engeli alırsan en kolayı **CMD** kullanmak.

1) `npm install`
2) `npm start`
3) Sunucu PC: http://localhost:3000
4) Diğer PC: http://SUNUCU_IP:3000

SUNUCU_IP: `ipconfig` -> IPv4 Address

## İlk giriş
- kullanıcı: admin
- şifre: admin1234
Admin panel: /admin.html

## Ses
En stabil yöntem:
- `public/notify.wav` dosyasını değiştir
- Admin panelde Ses URL: `/notify.wav`
