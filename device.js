/* Device detection: desktop/laptop vs mobile/tablet — drives control scheme */
(function(){
  var ua = navigator.userAgent || '';
  var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  var mobileUA = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
  // laptop vs desktop: both get keyboard+mouse; distinguish by screen + touch
  var isTouchDevice = touch && mobileUA;
  var isDesktop = !isTouchDevice;
  // crude laptop vs desktop: laptops usually have smaller screens + battery
  var screenIn = Math.sqrt(screen.width*screen.width + screen.height*screen.height) / (window.devicePixelRatio||1) / 96;
  var deviceType = isTouchDevice ? 'mobile' : (screenIn < 20 ? 'laptop' : 'desktop');

  window.DEVICE = {
    type: deviceType,          // 'desktop' | 'laptop' | 'mobile'
    touch: isTouchDevice,
    keyboard: isDesktop,
    label: deviceType.charAt(0).toUpperCase()+deviceType.slice(1)
  };
  var badge=document.getElementById('devbadge');
  badge.textContent = '🖥 '+window.DEVICE.label;
  badge.onclick=function(){ location.reload(); };
  if(isTouchDevice){
    document.getElementById('joy').style.display='block';
    document.getElementById('btns').style.display='flex';
    document.getElementById('kbhints').style.display='none';
  } else {
    document.getElementById('kbhints').style.display='block';
  }
})();
