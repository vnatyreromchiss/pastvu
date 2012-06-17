/**
 * Browser Detect
 * @author Klimashkin P.
 * @return {{name: string, version:string, versionN: number,
 *           engine: string, e_version: string, e_versionN: number,
 * 			 platform: string, support: Object.<string, boolean>}}
 */
define(["./flash_detect"], function (FlashDetect) {
	var b = {
		name : 'unknown',
		version : 'unknown',
		versionN : 0,
		engine : 'unknown',
		e_version : 'unknown',
		e_versionN : 0,
		platform : 'unknown',
		/**
		 * Индикаторы поддержки технологий
		 * @type Object.<string, boolean>
		 */
		support : {
			flash: FlashDetect && FlashDetect.installed, /*!!navigator.mimeTypes["application/x-shockwave-flash"],*/
			video: !!document.createElement('video').canPlayType,
			h264_apple_video : /** @return {boolean|string} */ function () {
				var vid = document.createElement('video');
				return !!vid && !!vid.canPlayType && vid.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
			}(),
			canvas: /** @return {boolean} */ function(){
				var canvas_compatible = false;
				try{
					canvas_compatible = !!(document.createElement('canvas').getContext('2d'));
				} catch(e) {}
				return canvas_compatible
			}(),
			geolocation: function(){
				return !!navigator.geolocation;
			}(),
			touch: function(){
				try {
					document.createEvent("TouchEvent");  
					return true;  
				} catch (e) {  
					return false;  
				}
			}(),
			chromeframe: false
		}
	};
	var uA = navigator.userAgent.toUpperCase(), res;
	
	function getSubstrUntilSpace(string,start){
		var result='';
		for(var i=start;i<string.length;i++){
			if(string.substr(i,1)==' ' || string.substr(i,1)==';') break;
			result+=string.substr(i,1);
		}
		return result;
	}
	if(uA.indexOf('OPERA')>=0){
		b.name = 'OPERA';
		b.engine = 'PRESTO';
		b.version = getSubstrUntilSpace(navigator.userAgent, uA.indexOf('VERSION/')+8);

		if (res = uA.match(/VERSION\/([\d\.]+)/i)) {
			b.versionN = parseFloat(res[1], 0);
		} else if (res = uA.match(/OPERA.([\d\.]+)/i)) {
			b.versionN = parseFloat(res[1], 0);
		}

		if (res = uA.match(/PRESTO\/([\d\.]+)/i)) {
			b.e_version = res[1];
			b.e_versionN = parseFloat(res[1], 0);
		}

	}else if(uA.indexOf('WEBKIT')>=0){
		b.engine = 'WEBKIT';
		if (res = uA.match(/WEBKIT\/([\d\.]+)/i)) {
			b.e_version = res[1];
		}
		if(uA.indexOf('CHROME')>=0){
			b.name='CHROME';
			b.version=getSubstrUntilSpace(navigator.userAgent, uA.indexOf('CHROME/')+7);
		}else if(uA.indexOf('SAFARI')>=0){
			b.name='SAFARI';
			b.version=getSubstrUntilSpace(navigator.userAgent, uA.indexOf('VERSION/')+8);
		}
	}else if(uA.indexOf('FIREFOX')>=0){
		b.name = 'FIREFOX';
		b.engine = 'GECKO';
		b.version = getSubstrUntilSpace(navigator.userAgent, uA.indexOf('FIREFOX/')+8); //uA.match(/FIREFOX\/([\d\.]+)/i)[1]
		
		if (res = uA.match(/RV:([\d\.]+)/i)) {
			b.e_version = res[1];
		}
	}else if(uA.indexOf('MSIE')>=0){
		b.name='MSIE';
		b.engine = 'TRIDENT';
		b.version=getSubstrUntilSpace(navigator.userAgent, uA.indexOf('MSIE ')+5);
		b.e_version=getSubstrUntilSpace(navigator.userAgent, uA.indexOf('TRIDENT/')+8);
		b.support.chromeframe = uA.indexOf('CHROMEFRAME') > -1 ? true : false;
	}
	
	b.platform = navigator.platform.toUpperCase();
	b.versionN = parseFloat(b.version, 0);
	b.e_versionN = parseFloat(b.e_version, 0);
	
	return b;
});