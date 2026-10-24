# Agent Panel

[![CI](https://github.com/Pheidiase/agent-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/Pheidiase/agent-panel/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Agent Panel, kendi Linux makinenizde Claude Code, Codex, Hermes ve kabuk oturumlarını yönetmek için kendi sunucunuzda çalışan bir web arayüzüdür.

[English](README.md) · [Güvenlik](SECURITY.md) · [Katkıda bulunma](CONTRIBUTING.md)

> [!CAUTION]
> **BU PANEL, TARAYICIDAN MAKİNENİZE KABUK ERİŞİMİ VERİR.**
> Giriş yapabilen kişi Panel'i çalıştıran kullanıcının yetkileriyle komut çalıştırabilir, dosyalarına ve ajan hesaplarına erişebilir. Dinleme adresini yerel bağlantıda (`127.0.0.1`) tutun; `0.0.0.0` veya `::` üzerinden dışarı açmayın. Güçlü, benzersiz parola kullanın. Uzaktan erişim yalnız HTTPS ters vekil veya tünel arkasından, tercihen bir erişim katmanıyla birlikte yapılmalıdır ([Agent Panel'i internete açmak](#agent-paneli-internete-açmak)). Panel tek sahip içindir; paylaşımlı barındırma hizmeti veya güvenilmeyen kodlar için yalıtılmış ortam değildir.

## Demo

<img src="docs/screenshots/demo.gif" alt="Agent Panel masaüstü demosu" width="100%">

## Ekran görüntüleri

<img src="docs/screenshots/desktop.png" alt="Agent Panel masaüstü ekran görüntüsü" width="100%">

<img src="docs/screenshots/mobile.png" alt="Agent Panel mobil ekran görüntüsü" width="300">

## Özellikler

- Kurulu Claude Code, Codex, Hermes ve kabuk programları için tmux içinde kalıcı terminal oturumları; web sürecini yeniden başlatmak terminal oturumlarını kapatmaz.
- Desteklenen ajan protokollerinde canlı terminal ve yapılandırılmış sohbet görünümü; araç etkinliği ve yeniden bağlanma desteği.
- Yerel sohbet geçmişi, arama, devam etme ve silme kontrolleri; dosya değişiklikleri ve fark paneli.
- İsteğe bağlı metaveriyle proje keşfi, oturum adlandırma ve proje görünürlüğü tercihleri.
- Bulunabilen yerel verilerden kullanım/kota görünümü: Codex oturum kayıtlarındaki limitler ve isteğe bağlı Claude kullanım özeti. Kullanılabilirlik ve güncellik ajana bağlıdır; faturalandırma API'si değildir.
- Yerel çalışma verisi varsa Hermes zamanlanmış görevlerini salt okunur görüntüleme.
- Masaüstü/mobil uyum, açık/koyu tema ve İngilizce/Türkçe arayüz.
- Yerel tek sahip parolasıyla giriş; isteğe bağlı mevcut portal SSO entegrasyonu (tek giriş sistemi). Başka portal kullanıcıları Panel'e erişemez.

## Gereksinimler

- Linux veya WSL2. WSL2 üzerinde systemd kullanmak için gerekiyorsa ayrıca etkinleştirin.
- `package.json` ile uyumlu Node.js: **`^22.23.4 || ^24.22.1 || ^26.12.1`** ve npm.
- `git`, `tmux`, Python 3 ve `node-pty` için yerel derleme araçları (C/C++ derleyicisi ve make).
- Ajan özellikleri için ayrıca kurulmuş ve hesabına giriş yapılmış en az bir ajan CLI'si (Claude Code, Codex veya Hermes). CLI, terminalden kullanılan komut satırı programıdır. Ajan CLI'si olmadan kabuk oturumları kullanılabilir.

Debian/Ubuntu ön koşul paketleri arasında `git tmux python3 build-essential` bulunur. Desteklenen Node.js sürümünü [nvm](https://github.com/nvm-sh/nvm) veya [nodejs.org](https://nodejs.org/) üzerinden kurun; dağıtım paketleri eski kalabilir. Panel ajan CLI'lerini kurmaz, sağlayıcı hesaplarına giriş yapmaz ve kimlik bilgilerini yönetmez.

## Hızlı kurulum

`<repository-url>` yerine bu deponun klonlama adresini yazın:

```sh
git clone <repository-url> agent-panel
cd agent-panel
npm ci
npm run build
npm run setup
npm run set-password
npm start
```

**http://127.0.0.1:4317** adresini açın. İlk parola komutu sahip kullanıcı adını ve gizli girilen parolayı sorar (12–200 karakter). Kullanıcı adını açıkça belirtmek için `npm run set-password -- --owner --rename owner` kullanın. Parolayı değiştirmek için aynı komutu yeniden çalıştırın; parolayı komut argümanına veya ortam değişkenine yazmayın.

Terminalde parolayı her gizli istem göründükten sonra girin; her istemden önce bekleyen girdi atılır ve parola tekrarı istenir. Otomasyon için TTY olmayan stdin, istem, tekrar veya yankılama olmadan tam bir parola satırı kabul eder (son satır sonu isteğe bağlıdır). Güvenilir bir boru veya yönlendirilmiş özel dosya kullanın; girdiyi sağlayan program da parolayı kaydetmemelidir. TTY olmayan stdin ile ilk kurulumda `--owner --rename <kullanıcı-adı>` gerekir.

Kurulum ön koşulları denetler; özel durum dizinini (`0700`), `agents.json` ve yerel `auth.json` dosyalarını (`0600`) oluşturur, mevcut dosyaların içeriğini korur. Parola üretmez, tünel yapılandırmaz ve servis etkinleştirmez. Bulunamayan ajanlar kullanılamaz görünür. CLI kurduktan veya değiştirdikten sonra web sürecini yeniden başlatın.

## Sorun giderme

Kurulumdan sonra `node-pty` yüklenemiyorsa npm 11 kurulum betiği için izin bekliyor olabilir. Panel dizininde çalıştırın:

```sh
npm install-scripts approve node-pty
npm rebuild node-pty
```

Yerel derleme gerekirse önce C/C++ derleyicisi, make ve Python 3 kurun. Debian/Ubuntu üzerinde bunları `build-essential` ve `python3` paketleri sağlar; ardından derlemeyi tekrar deneyin.

## Yapılandırma

Durum dizini varsayılan olarak `<proje>/var` konumudur; sürüm kontrolüne ve public paketlere almayın. JSON ayarları başlangıçta okunur; değişiklikten sonra web sürecini yeniden başlatın. Ortam değişkenleri ilgili dosya ayarlarından önceliklidir. Örnekler [examples/](examples/) altında; kopyalamadan önce inceleyin. Boş `agents.json` örneği PATH üzerinden program keşfeder; kurulum normalde keşfettiği mutlak program yollarını yazar. `settings.json` ve `projects.json` isteğe bağlıdır ve kurulum tarafından üretilmez.

| Ayar | Varsayılan | Amaç |
| --- | --- | --- |
| `PANEL_STATE_DIR` | `<proje>/var` | Özel ayarlar ve çalışma verisi. |
| `PANEL_WORKSPACE` / `settings.json.workspace` | Panel dizininin üstü | Doğrudan altındaki proje dizinleri keşfedilir. Bağıl yollar Panel köküne göre çözülür. Örnekteki `../projects` dizinini oluşturun veya mevcut dizin seçin. |
| `PANEL_HOST` / `settings.json.host` | `127.0.0.1` | Dinleme IP adresi; uzaktan vekil/tünel erişiminde de yerel tutun. |
| `PANEL_PORT` / `settings.json.port` | `4317` | TCP portu, 1–65535. |
| `settings.json.homeUrl` | Yok (bağlantılar gizli) | İsteğe bağlı HTTP(S) gezinme bağlantısı; Host/Origin erişim izni vermez. Gerekmiyorsa örnek adresi kaldırın. |
| Durum dizinindeki `projects.json` | `config/projects.json` | Metaveri dizisinin tamamının yerine geçer; dizin keşfi devam eder. Ev dizini kaydını tutmak için `general` kaydını koruyun. |
| Durum dizinindeki `agents.json` | PATH keşfi | `claude`, `codex`, `hermes`, `shell` için program yolu veya komut adı; eksik anahtarlar PATH'ten bulunur (kabuk için `bash`). Komut argümanı yazılmaz. |
| `auth.json.mode` | `local` | `local` veya `portal`; mevcut dosyada `mode` açıkça bulunmalıdır. Modlar arasında otomatik geçiş yoktur. |
| `auth.json.trustProxyHeader` | `false` | Yalnız yerel soketten gelen tek geçerli `CF-Connecting-IP` değerine güvenir. Yalnız güvenilir yerel vekil dışarıdan gelen kopyaları temizleyip gerçek istemci IP'sini yazıyorsa açın. Diğer yönlendirme başlıkları yok sayılır. |
| Durum dizinindeki `named-origins.json` | Uzak origin yok | `{ "origins": ["https://panel.example.com"] }`; yol, sondaki eğik çizgi veya açık port içermeyen en çok sekiz tam HTTPS origin'i (protokol ve sunucu adresi). |
| Durum dizinindeki `public-origin.json` | Yok | Eski hızlı tünel desteği: `{ "origin": "https://example.trycloudflare.com" }`. Yalnız bu tam hızlı tünel origin'i kabul edilir. |
| `PANEL_TMUX_BINARY` / `PANEL_PYTHON_BINARY` | PATH `tmux` / `python3` | Zorunlu çalışma araçları. |
| `PANEL_CLAUDE_BINARY` / `PANEL_CODEX_BINARY` | Ajan ayarı, sonra PATH | Claude Code / Codex programlarını ezer. |
| `PANEL_ACP_BINARY` / `PANEL_SHELL_BINARY` | Ajan ayarı, sonra PATH | Hermes / kabuk programlarını ezer. |
| `PANEL_TMUX_SOCKET` | `<durum>/tmux.sock` | Panel'e ait tmux soketi. |
| `PANEL_SYSTEMCTL_BINARY` | PATH `systemctl` | `setup --systemd` ön koşul kontrolü; kurulum bu komutu çalıştırmaz. |
| `PATH` | Sürecin ortamı | Program keşfi. Geçersiz açık program ayarı ajanı devre dışı bırakır; sessizce başka program kullanılmaz. |
| `XDG_CONFIG_HOME` | `~/.config` | `setup --systemd` kullanıcı servisleri için taban dizin. |

Durum verisini özel tutun (`0700` dizin, `0600` kimlik dosyaları). `owner.json`, oturum verisi, audit kayıtları veya ajan giriş bilgilerini örneklere kopyalamayın. Yerel mod tek Node web süreciyle çalışır; çok işçili dağıtım desteklenmez.

### Giriş modları

**Yerel**, bağımsız kurulumun varsayılanıdır. `npm run set-password` tek sahip hesabını oluşturur veya günceller; tarayıcı hesap oluşturamaz. Parola değişimi eski oturumları geçersiz kılar. Giriş verisi özeldir; güvenli yedeklenmelidir.

**Portal**, uyumlu portal protokolünü zaten işleten kurulumlar için isteğe bağlıdır; portal sunucusu pakete dahil değildir. Durum dizinindeki `auth.json` içinde `{ "mode": "portal", "trustProxyHeader": false }` ile açıkça seçin; özel `auth-client.json` dosyasını portal yönetiminizle hazırlayın. Alanları `app` (`panel`), `key` (ortak sır), `portalInternal` (yerel HTTP servisi), `portalOrigin` ve `publicOrigin` (tam origin adresleri). Kimlik, parola ve izinler portalın sorumluluğundadır. Panel **yalnız sahibine** açıktır: proje izinleri başka portal kullanıcısına erişim vermez. Eski `auth-client.json` tek başına portal modunu seçmez. Kurulum mevcut `auth.json` dosyasını korur; mevcut kurulumu yükseltmeden önce doğru modu ayarlayın.

## Uzaktan erişim

Panel'i `127.0.0.1:4317` üzerinde tutun. Önüne HTTPS ters vekil veya tünel koyun; dış Host ve Origin başlıklarını korusun ve WebSocket bağlantı yükseltmelerini desteklesin. Tam dış origin'i durum dizinindeki `named-origins.json` dosyasına ekleyip web sürecini yeniden başlatın. Dinleme adresini veya `homeUrl` değerini değiştirmek izinli origin eklemez. Yerel bağlantı dışındaki oturumlar güvenli çerez ve HTTPS gerektirir.

Örneğin Cloudflare'ın kendi yönergeleriyle Cloudflare Tunnel oluşturup işletin; kendi sunucu adınızı (`panel.example.com` gibi) `http://127.0.0.1:4317` adresine yönlendirin ve `named-origins.json` içine `https://panel.example.com` iznini ekleyin. Tünel kimlik bilgilerini depo dışında tutun. Panel tüneli kurmaz ve yönetmez. Güvenilir yerel vekil yukarıdaki başlık yönetimini garanti etmiyorsa `trustProxyHeader` kapalı kalsın; kapalıyken vekil arkasındaki istemciler vekilin IP hız sınırını paylaşır.

## Agent Panel'i internete açmak

Panel'i makinenizin dışından erişilebilir yapmadan önce bunu okuyun.

**Giriş yapan herkes kullanıcı hesabınızın tüm yetkisini kazanır.** Kabuk ajanı gerçek bir terminaldir, kodlama ajanları da sizin adınıza komut çalıştırır. Panel parolasına SSH özel anahtarı gibi davranın: sızarsa makine ele geçirilmiş demektir.

- **Router'dan port yönlendirmeyin, `0.0.0.0` veya `::` adresine bağlamayın.** Varsayılan `127.0.0.1`'dir; öyle kalsın ve Panel'e yerel bağlantıya ulaşan bir tünel ya da vekil üzerinden erişin.
- **Önüne kimlik doğrulayan bir katman koyun; saldırgan giriş sayfasına bile ulaşamasın.** En basitten başlayarak seçenekler:
  - **Cloudflare Tunnel + Cloudflare Access.** Tünel dışarıya doğru bağlanır, gelen bağlantı için port açılmaz. Sunucu adınız için bir Access uygulaması ekleyin; politikası yalnız sizin e-postanıza (tek kullanımlık kod) veya SSO kimliğinize izin versin. Cloudflare'ın Zero Trust belgelerini izleyin; ardından tam `https://` origin'i `named-origins.json` içine ekleyin.
  - **Özel ağ:** Tailscale veya WireGuard gibi. Panel yalnız kendi cihazlarınızdan erişilebilir olur. Tarayıcı yine HTTPS alsın diye (yerel bağlantı dışındaki oturumlar güvenli çerez ister) özel adreste bir ters vekil çalıştırın veya `tailscale serve` kullanın.
  - **SSH tüneli**, ara sıra erişim için: `ssh -L 4317:127.0.0.1:4317 kullanici@sunucunuz`, sonra kendi bilgisayarınızda `http://127.0.0.1:4317` adresini açın. Hiçbir şey dışarı açılmaz.
- **Tahmin edilemez alt alan adı koruma sayılmaz.** Herkese açık sunucu adları Certificate Transparency kayıtlarından ve DNS'ten bulunabilir; tarayıcı botlar yeni HTTPS adlarını çoğu zaman dakikalar içinde yoklar. Gizli bir isme değil, erişim katmanına güvenin.
- **Uzun ve benzersiz bir parola kullanın.** Komut satırı aracı 12–200 karakter ister; başka hiçbir yerde kullanmadığınız, parola yöneticisinin ürettiği bir parola seçin. Hatalı girişler istemci IP'si ve kullanıcı adı başına hız sınırına tabidir; bu tahmini yavaşlatır ama erişim katmanının yerini tutmaz. Vekil arkasındayken, vekil [Yapılandırma](#yapılandırma) bölümündeki koşulları sağlamıyorsa `trustProxyHeader` kapalı kalsın; aksi halde tüm ziyaretçiler vekilin IP hakkını paylaşır.
- **Henüz yerleşik iki adımlı doğrulama yok.** Yukarıdaki erişim katmanının önemi bu yüzden: ikinci adımı o sağlar.
- **İsterseniz Kabuk ajanını kapatın.** Durum dizinindeki `agents.json` içinde `"shell"` değerini var olmayan bir yola ayarlayın, örneğin `{ "shell": "/nonexistent" }`, ve web sürecini yeniden başlatın; Panel Kabuk'u kullanılamaz gösterir ve kabuk oturumu başlatmayı reddeder. `PANEL_SHELL_BINARY` tanımlıysa o önceliklidir, kaldırın. Bu maruziyeti azaltır ama Panel'i açmak için yeterli değildir: Claude Code, Codex ve Hermes makinenizde yine komut çalıştırabilir.

Kurulumu güvenmeden önce dışarıdaki bir ağdan (mobil veriye bağlı telefon) deneyin: Panel'in giriş sayfasını değil, erişim katmanının giriş ekranını görmelisiniz.

## systemd ile çalıştırma

Derleme ve parola ayarlama sonrasında:

```sh
npm run setup -- --systemd
```

Bu komut `~/.config/systemd/user` (veya `XDG_CONFIG_HOME`) altına yeni `agent-panel-tmux.service` ve `agent-panel-web.service` kullanıcı servis dosyaları yazar. Mevcut dosyaların üzerine yazmaz; hiçbir şeyi başlatmaz veya etkinleştirmez. Üretilen dosyaları inceleyip kendiniz etkinleştirin:

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-panel-tmux.service agent-panel-web.service
```

Web ve tmux ayrı servislerdir. Terminal oturumlarını korumak için yalnız `agent-panel-web.service` servisini yeniden başlatın; tmux'u durdurmak oturumları sonlandırır. Çıkış veya yeniden açılıştan sonra kullanıcı servislerinin çalışması sistemin oturum/linger ayarına bağlıdır. Aynı port ve durum dizininde servisin yanında ayrıca `npm start` çalıştırmayın.

## Geliştirme ve test

```sh
npm test
npm run build
node node_modules/vite/bin/vite.js --host 127.0.0.1
```

Vite geliştirmede arayüzü sunar; normal kimlik doğrulamalı kullanım Node sunucusunu ve derlenmiş dosyaları kullanır. Testler sentetik veriler kullanır; gerçek model istemi veya mesaj göndermemelidir. Bazı entegrasyon testleri yerel alt süreç, tmux veya yerel dinleme portu gerektirir; kısıtlı sandbox bunları engelleyebilir. Ayrıntı: [CONTRIBUTING.md](CONTRIBUTING.md).

## Lisans

Agent Panel [MIT Lisansı](LICENSE) ile yayınlanmaktadır.
