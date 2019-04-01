const request=require('request');
const urlModule = require('url');
const crypto = require('crypto');
var sameTime = new require('./sameTime.js');

function now(){
  return (new Date()).getTime();
}

var downloadLimit=new sameTime(2);

module.exports=function(options,listName){
  var queue =[];
  var files={};
  var listGetterTimeout=null;
  var lastPlayListReq;
  var baseUrl=options.playlist.replace(/\/[^\/]+$/,'/');
  var stat=this.stat={
    name:listName,
    files:0,
    filesCached:{},
    playlistsCached:0,
    loading:0,
    time:0
  };
  //var clearTime={};

  var statInterval=setInterval(function(){
    console.log('%j',stat);
  },5000);
  statInterval.unref();

  function fileCache(url,fileKey){
    var data=null;
    var headers=null;
    var resQueue=[];
    var finished=false;
    var errResponse=null;
    //console.log("file",fileKey);

    var processResponse=this.processResponse=function(res){
      if (!data) {
        resQueue.push(res);
        return;
      }

      res.writeHead(errResponse||200, {
        'Content-Length': data.length,
        'Content-Type': headers['content-type']
      })
      res.end(data);
    }
    var tryCount=0;
    var code=null;

    function getSegment(){
      tryCount++;
      stat.loading++;
      downloadLimit.run(request.get,{url:url, encoding:null},(err,resp,rdata)=>{
        downloadLimit.e();
        stat.loading--;
        err && console.log(err);
        if (resp && resp.statusCode==200){
          headers=resp.headers;
          data=rdata;
          code=resp.statusCode;
          while (resQueue.length){
            processResponse(resQueue.pop());
          }
        }else if(resp && resp.statusCode==404 && tryCount<12){
          data=rdata;
          code=resp.statusCode;
          headers=resp.headers;
          errResponse=404;
          while (resQueue.length){
            processResponse(resQueue.pop());
          }
        }else{
          console.log("URL failed "+url+" tryAgain",resp && resp.statusCode);
          !finished && setTimeout(getSegment,2000);
        }
        if (data && code){
          stat.filesCached[code]=stat.filesCached[code]||0;
          stat.filesCached[code]++;
        }
      });//request TS under limit
    }//getSegment
    setTimeout(getSegment,options.tsLoadDelay||4000);
    this.time=now();
    stat.files++;
    setTimeout(function(){
      //console.log("Clean ts ",fileKey);
      delete files[fileKey];
      //clearTime[fileKey]=now();
      stat.files--;
      if (data && code && stat.filesCached[code]){
        stat.filesCached[code]--;
      }
      finished=true;

      while (resQueue.length){
        var res=resQueue.pop();
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Load segment timeout');
      }
    },options.bufferTime+options.cleanAfter).unref();
    return this;
  }

  function getList(){
    var rtime=now();
    request.get(options.playlist,(err,resp,data)=>{
      err && console.log(err);
      if (!resp){
        console.log("Error "+options);
      }
      if (resp && resp.statusCode==200){

        //data=data.split(baseUrl).join('');
        var byLines=data.toString().split(/\r?\n/g);

        byLines.forEach((line,idx)=>{
          if (line && !/^\#/.test(line)){
            var url=line;
            //url=url.replace(baseUrl,'');
            if (!/^http/.test(url)){
              url=urlModule.resolve(options.playlist,url);
            }
            var filename=line.replace(/(.*)\/([^\/]+)$/,'$2');
            var hash = crypto.createHash('md5').update(filename).
              digest("hex")+(filename.replace(/([^\.]+)\.(.*)$/,'.$2')||'.raw')
            //console.log('TS url:%s fileKey:%s',url,hash);
            byLines[idx]=hash;
            //clearTime[hash] && console.log("HIT!",url);
            files[hash]=files[hash]||new fileCache(url,hash)
          }
        });
        queue.unshift({
          time:rtime,
          playList:byLines.join("\n"),
          headers:resp.headers
        });
        stat.playlistsCached=queue.length;

        //Remove old playlists
        while(queue.length && (queue[queue.length-1].time<(rtime-(options.bufferTime+options.cleanAfter)))){
          let rmPls=queue.pop()
          //console.log("Clean play list ",new Date(rmPls.time));
        }
        var lastBuf=queue[queue.length-1];
        if (lastBuf){
          stat.time=now()-lastBuf.time;
        }
      }
      if (lastPlayListReq && ((now()-lastPlayListReq)>(options.bufferTime+options.cleanAfter+15000))){
        console.log("stop list check cycle "+listName);
        queue=[];
        clearInterval(statInterval);
        listGetterTimeout=null;
      }else{
        listGetterTimeout=setTimeout(getList,options.checkInterval);
      }
    });//request.get
  }//getList

  function startFromUpstream(){
    if (listGetterTimeout)return;
    listGetterTimeout=setTimeout(getList,1);
  }

  var onPlayListReq=this.onPlayListReq=function(req,res){
    var curBuf=this;
    lastPlayListReq=now();
    startFromUpstream();
    if (!req) return;
    req.time=req.time||now();
    if ((now()-req.time)>(options.bufferTime+10000)){
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Can not get source m3u8');
      return
    }
    for (var i=0;i<queue.length;i++){

      if ((now()-queue[i].time)>options.bufferTime){
        //console.log("Send pls",req.socket.localAddress);
        res.writeHead(200, {
          'Content-Length': Buffer.byteLength(queue[i].playList),
          'Content-Type': queue[i].headers['content-type']
        })
        res.end(queue[i].playList);
        return;
      }
    }
    setTimeout(onPlayListReq,options.checkInterval,req,res);
  }

  var onFileReq=this.onFileReq=function(req,res){
    var fileKey=req.fileKey||req.url;

    function tryGetCachedFile(cycle){
      var file=files[fileKey];
      if (!file && cycle>6){
        console.log('404 fileKey:%s cycle:%s',fileKey,cycle);// clearTime[fileKey] && (now()-clearTime[fileKey]));//,ar.join('|'));
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (!file){
        setTimeout(tryGetCachedFile,1000,cycle+1);
        return;
      }

      file.processResponse(res);
    }
    tryGetCachedFile(0);

  }

  return this;
}