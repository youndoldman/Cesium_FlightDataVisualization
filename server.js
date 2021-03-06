(function () {
    'use strict';

    // Dependencies
    var express = require('express');
    var url = require('url');
    var request = require('request');
    var fs = require("fs");
    var bodyParser = require("body-parser");
    var httpGet = require("http");


    // Variables in which to store imortant information:
    var streaming = true;
    var CZMLHeader; // This is the first packet in the CZML stream, which should be sent first in every GET-request
    var CZMLRocket; // The packet containing graphical information about the rocket
    var CZMLSpeed; // Packet containing information to be stated in text
    var recordData = false; // Set this variable to true if you want to record data. NOTE: This function is not fully implemented, DO NOT USE
    var rocketName = "Maxus9.czml"; // Name of the file that will contain the recorded data
    var loggValues = false; // Set this variable to true if you want to logg data for plotting

    var yargs = require('yargs').options({
        'port': {
            'default': process.env.PORT || 8080,
            'description': 'Port to listen on.'
        },
        'public': {
            'type': 'boolean',
            'description': 'Run a public server that listens on all interfaces.'
        },
        'upstream-proxy': {
            'description': 'A standard proxy server that will be used to retrieve data.  Specify a URL including port, e.g. "http://proxy:8000".'
        },
        'bypass-upstream-proxy-hosts': {
            'description': 'A comma separated list of hosts that will bypass the specified upstream_proxy, e.g. "lanhost1,lanhost2"'
        },
        'help': {
            'alias': 'h',
            'type': 'boolean',
            'description': 'Show this help.'
        }
    });

    var argv = yargs.argv;

    if (argv.help) {
        return yargs.showHelp();
    }

    argv.public = true;

    var mime = express.static.mime;
    mime.define({
        'application/json': ['czml', 'json', 'geojson', 'topojson'],
        'model/vnd.gltf+json': ['gltf'],
        'model/vnd.gltf.binary': ['bgltf', 'glb'],
        'text/plain': ['glsl']
    });

    var app = express();
    app.use(function (req, resp, next) {
        resp.header("Access-Control-Allow-Origin", "*");
        resp.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        next();
    });
   
    app.use(express.static(__dirname));

    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(bodyParser.json());

    var streamCSV; //Stream to backlog.csv
    var streamCSV2; //Stream to events.csv, used to print the events
    var streamPositionsCSV; //Stream to positions.csv
    var streamTimesCSV; // Time logs 
    var streamQuaternionsCSV; // Attitude logs
    var streamSpeedsCSV; // Speed logs
    var streamGLoadsCSV; // GLoad logs
    var streamARatesCSV; // Angular rate logs
    var streamCZML; //stream to the backlog.czml, used to load data on client connect
    var recordedCZML = []; //array containing the recorded czml

    var positionsTempString = []; //String used to construct a newpositions array in order to minimize write sizes
    var positionsOnlyTempString = []; //same as positionsTempString, but excluding the timestamps
    var coordinatesOnlyTempString = []; //same as positionsTempString, but excluding the timestamps
    var orientationsTempString = []; //String used to construct a new positions array in order to minimize write sizes
    var positionsTempString = []; //String used to construct a new orientations array in order to minimize write sizes
    var speedsTempString = []; //String used to construct a new speeds array in order to minimize write sizes
    var packetNumber = 0; //Keeping track of the packet number
    var startEpoch; //The epoch of the initial rocket packet
    var streaming = false;
    var date = new Date();

    var postInterval;
    var timeSinceLastPost;
    var lastEvent = "";

    // Store client connections in an array
    var openConnections = [];

    var postReq;
    var postResp;

    var czmlString = []; //Will store the czml backlog in this variable, and then write everything to the file for the client read.
    var firstPacket = true;

    var connectionVerified = false;


    // This routing method handles the basically all data, and route POST data to the clients that made the GET request
    app.all("/czml", function (req, resp) {
        var getReq;
        var getResp;

        if (req.method === "POST") {
            var t0 = new Date().getTime();
            postReq = req;
            console.log(postReq.body);
            console.log("Number of connections: " + openConnections.length);
            postResp = resp;
            czmlString = []; //Resetting the czmlString every call POST request, otherwise we get a memory leak due to the string just appending the same thing over and over.

            if (!connectionVerified) {
                if (postReq.body[0].name === "Ver!WrdZ<?") {
                    postReq.body[0].name = "document";
                    connectionVerified = true;
                    console.log('Connection verified');

                    console.log(postReq.body);

                    // This is the first packet arriving
                    CZMLHeader = postReq.body;

                    //creating streams in order to stor backlogs. These backlogs will then be loaded whenever a client connects mid-flight.
                    streamCSV = fs.createWriteStream("backlog.csv");
                    streamCSV2 = fs.createWriteStream("events.csv");
                    streamPositionsCSV = fs.createWriteStream("positions.csv");
                    streamSpeedsCSV = fs.createWriteStream("speeds.csv");
                    streamQuaternionsCSV = fs.createWriteStream("quats.csv");
                    streamTimesCSV = fs.createWriteStream("times.csv");
                    streamGLoadsCSV = fs.createWriteStream("gLoads.csv");
                    streamARatesCSV = fs.createWriteStream("aRates.csv");
                    streamCZML = fs.createWriteStream("backlog.czml");

                    // Not used atm
                    if (recordData) {
                        var fd = fs.openSync(rocketName, 'w');
                    }

                    // Noting that we are currently streaming
                    streaming = true;
                    console.log("Connection open, currently streaming");

                    streamCSV.write('altitude,time' + '\n');
                    streamCSV2.write('event,time' + '\n');

                    // Write the document czml packet to all connected clients
                    openConnections.forEach(function (clientresp) {
                        clientresp.write('data:' + JSON.stringify(CZMLHeader) + '\n\n');
                    });
                    firstPacket = false;

                    // Not used atm
                    if (recordData) {
                        recordedCZML.push(CZMLHeader[0]);
                    }

                    timeSinceLastPost = new Date().getTime();
                    // Notify the pusher that post is successful
                    postResp.send('POST successful!');
                } else {
                    // Just terminate request if it can't be verified
                    console.log('Connection not verified')
                    postResp.send('Connection not verified');
                }
            }
            // If connection already is verified
            else {
                if (postReq.body[0].id === "rocket") {
                    CZMLRocket = postReq.body;

                    // If position data is received
                    if (typeof CZMLRocket[0].position !== 'undefined') {
                        var positions = CZMLRocket[0].position.cartographicDegrees;

                        // Extract the position
                        positions.forEach(function (pos, index) {
                            if (index % 4 === 0) {
                                // This is the time since initial epoch, based on a push frequency of 2 Hz
                                positionsTempString.push(pos + packetNumber * 0.5);// This is not a very flexible solution, but based on the fact that we know that the packets are sampled every 0.5s..
                            } else {
                                positionsTempString.push(pos);
                                positionsOnlyTempString.push(pos);
                            }
                        });

                        // Redefine the polyline to contain all previous positions
                        if (typeof CZMLRocket[4].polyline.positions !== 'undefined') {
                            CZMLRocket[4].polyline.positions.cartographicDegrees = positionsOnlyTempString;
                        }

                        // Write the time and altitude to the file used for plotting the height curve
                        if (typeof CZMLRocket[2].point.pixelSize !== 'undefined') {
                            var missionTime = CZMLRocket[2].point.pixelSize;
                            if (missionTime > 0) {
                                streamCSV.write(JSON.stringify(positions[3] + 330) + ',' + JSON.stringify(missionTime) + '\n');

                                if (typeof CZMLRocket[4].polyline.positions !== 'undefined') {
                                    czmlString.push(CZMLHeader[0]);
                                    czmlString.push(CZMLRocket[4]);
                                }
                            }
                        }
                    }

                    // Used to record data, but not functional yet
                    if (recordData) {
                        recordedCZML.push(CZMLRocket[0]);
                        recordedCZML.push(CZMLRocket[1]);
                        recordedCZML.push(CZMLRocket[2]);
                        recordedCZML.push(CZMLRocket[3]);
                    }

                    // Check if a new event is available, and in that case, write it to the event backlog
                    if (typeof CZMLRocket[1].name !== 'undefined') {
                        if (CZMLRocket[1].name !== lastEvent) {
                            streamCSV2.write(CZMLRocket[1].name + ',' + CZMLRocket[2].name + '\n');
                            lastEvent = CZMLRocket[1].name;
                        }
                    }

                    //Logging values for the purpose of plotting and analyzing, set loggValues to true if you want to do that
                    if (loggValues) {
                        // Log positions
                        if (typeof CZMLRocket[0].position !== 'undefined') {
                            var positions = CZMLRocket[0].position.cartographicDegrees;

                            var time;
                            if (typeof CZMLRocket[2].point.pixelSize !== 'undefined') {
                                time = CZMLRocket[2].point.pixelSize;
                            } else {
                                time = -1;
                            }

                            for (var i = 0; i < positions.length / 4; i++) {
                                streamPositionsCSV.write(JSON.stringify(positions[i * 4 + 1]) + ',' + JSON.stringify(positions[i * 4 + 2]) + ',' + JSON.stringify(positions[i * 4 + 3]) + ',' + JSON.stringify(time) + '\n');
                            }
                        }

                        // Log attitude
                        if (typeof CZMLRocket[0].orientation !== 'undefined') {
                            var orientations = CZMLRocket[0].orientation.unitQuaternion;

                            var time;
                            if (typeof CZMLRocket[2].point.pixelSize !== 'undefined') {
                                time = CZMLRocket[2].point.pixelSize;
                            } else {
                                time = -1;
                            }

                            for (var i = 0; i < orientations.length / 5; i++) {
                                streamQuaternionsCSV.write(JSON.stringify(orientations[i * 5 + 4]) + ',' + JSON.stringify(orientations[i * 5 + 1]) + ',' + JSON.stringify(orientations[i * 5 + 2]) + ',' + JSON.stringify(orientations[i * 5 + 3]) + ',' + JSON.stringify(time) + '\n');
                            }
                        }

                        // Log speed
                        if (typeof CZMLRocket[1].point.pixelSize !== 'undefined') {
                            var speed = CZMLRocket[1].point.pixelSize;

                            var time;
                            if (typeof CZMLRocket[2].point.pixelSize !== 'undefined') {
                                time = CZMLRocket[2].point.pixelSize;
                            } else {
                                time = -1;
                            }

                            streamSpeedsCSV.write(JSON.stringify(speed) + ',' + JSON.stringify(time) + '\n');
                        }

                        // Log gLoads
                        if (typeof CZMLRocket[1].point.position !== 'undefined') {
                            var gLoads = CZMLRocket[1].point.position.cartesian;

                            var time;
                            if (typeof CZMLRocket[2].point.pixelSize !== 'undefined') {
                                time = CZMLRocket[2].point.pixelSize;
                            } else {
                                time = -1;
                            }

                            streamGLoadsCSV.write(JSON.stringify(gLoads[0]) + ',' + JSON.stringify(gLoads[1]) + ',' + JSON.stringify(gLoads[2]) + ',' + JSON.stringify(time) + '\n');
                        }

                        // Log time
                        if (typeof CZMLRocket[2].point.pixelSize !== 'undefined') {
                            var time = CZMLRocket[2].point.pixelSize;
                            streamTimesCSV.write(JSON.stringify(time) + '\n');
                        }

                        // Log angular rates
                        if (typeof CZMLRocket[2].point.position !== 'undefined') {
                            var aRates = CZMLRocket[2].point.position.cartesian;

                            var time;
                            if (typeof CZMLRocket[2].point.pixelSize !== 'undefined') {
                                time = CZMLRocket[2].point.pixelSize;
                            } else {
                                time = -1;
                            }

                            streamARatesCSV.write(JSON.stringify(aRates[0]) + ',' + JSON.stringify(aRates[1]) + ',' + JSON.stringify(aRates[2]) + ',' + JSON.stringify(time) + '\n');
                        }

                    }

                    // Once the logging is done, send the necessary packets to the clients
                    openConnections.forEach(function (getResp) {
                        getResp.write('data:[' + JSON.stringify(CZMLRocket[0]) + ',' + JSON.stringify(CZMLRocket[1]) + ',' + JSON.stringify(CZMLRocket[2]) + ',' + JSON.stringify(CZMLRocket[3]) + ']' + '\n\n');
                    });
                    
                    packetNumber += 1
                }
                timeSinceLastPost = new Date().getTime();

                // Re-write the backlog since there is no good way of just appending (?)
                fs.truncateSync("backlog.czml");
                fs.writeFileSync("backlog.czml", JSON.stringify(czmlString));

                if (loggValues) {
                    fs.truncateSync(rocketName);
                    fs.writeFileSync(rocketName, JSON.stringify(recordedCZML));
                }

                // A timer that keeps track of the time between POST requests. It the time is too large, it will assume that the pusher has disconnected, and reset some variables
                if (postInterval === undefined) {
                    postInterval = setInterval(function () {
                        if ((new Date().getTime() - timeSinceLastPost > 2500)) {
                            streamCSV.close();
                            streamCZML.close();
                            streamPositionsCSV.close();
                            streamQuaternionsCSV.close();
                            streamTimesCSV.close();
                            streamGLoadsCSV.close();
                            streamARatesCSV.close();
                            streamSpeedsCSV.close();
                            streaming = false;
                            console.log("Connection closed, stream closed");
                            CZMLRocket = undefined;
                            postReq = undefined;
                            postResp = undefined;
                            czmlString = [];
                            packetNumber = 0;
                            positionsOnlyTempString = [];
                            clearInterval(postInterval);
                            postInterval = undefined;
                            connectionVerified = false;
                        }
                    }, 5000);
                }
                var t1 = new Date().getTime();
                console.log("Call to handle the POST request took " + (t1 - t0) + " milliseconds.");
                postResp.send('POST request successful');
            }

            ////              ------------------------------------------------------------------------------------------------------------------------
            ////              --------------This does not work on heroku, workaround using setIntervall instead. Uncomment this is fixed.-------------
            //                // Attaching listener, on closed connection: set "streaming" to false and reset all variables associated with the stream
            //                postResp.connection.addListener("close", function () {
            //                    streamCSV.close();
            //                    streamCZML.close();
            //                    streaming = false;
            //                    console.log("Connection closed, stream closed");
            //                    CZMLHeader = undefined;
            //                    CZMLRocket = undefined;
            //                    postReq = undefined;
            //                    postResp = undefined;
            //                    czmlString = [];
            //                    packetNumber = 0;
            //                    positionsOnlyTempString = [];
            //                });
            ////              ------------------------------------------------------------------------------------------------------------------------

        }
        // For every new client connected, this section will be entered
        else if (req.method === "GET") {
            getReq = req;
            getResp = resp;

            // Store the new connection in the array
            openConnections.push(getResp);

            // Define headers
            getResp.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });

            // If the pusher isn't active, just send the document packet to prepare the client
            if (!(postReq == null)) {
                getResp.write('data:' + JSON.stringify(CZMLHeader) + '\n\n');
            }

            // If the client disconnects, remove it from the list
            req.connection.on("close", function () {
                var toRemove;
                for (var j = 0; j < openConnections.length; j++) {
                    if (openConnections[j] === resp) {
                        toRemove = j;
                        break;
                    }
                }
                openConnections.splice(j, 1);
                console.log(openConnections.length.toString());
            });

        }
    });

    //// Keeping the heroku app alive
    //setInterval(function () {
    //    httpGet.get("http://sscflightdata.herokuapp.com");
    //}, 290000);

    //--------------------------------------

    function getRemoteUrlFromParam(req) {
        var remoteUrl = req.params[0];
        if (remoteUrl) {
            // add http:// to the URL if no protocol is present
            if (!/^https?:\/\//.test(remoteUrl)) {
                remoteUrl = 'http://' + remoteUrl;
            }
            remoteUrl = url.parse(remoteUrl);
            // copy query string
            remoteUrl.search = url.parse(req.url).search;
        }
        return remoteUrl;
    }

    var dontProxyHeaderRegex = /^(?:Host|Proxy-Connection|Connection|Keep-Alive|Transfer-Encoding|TE|Trailer|Proxy-Authorization|Proxy-Authenticate|Upgrade)$/i;

    function filterHeaders(req, headers) {
        var result = {};
        // filter out headers that are listed in the regex above
        Object.keys(headers).forEach(function (name) {
            if (!dontProxyHeaderRegex.test(name)) {
                result[name] = headers[name];
            }
        });
        return result;
    }

    var upstreamProxy = argv['upstream-proxy'];
    var bypassUpstreamProxyHosts = {};
    if (argv['bypass-upstream-proxy-hosts']) {
        argv['bypass-upstream-proxy-hosts'].split(',').forEach(function (host) {
            bypassUpstreamProxyHosts[host.toLowerCase()] = true;
        });
    }

    // Handles proxy requests
    app.get('/proxy/*', function (req, res, next) {
        // look for request like http://localhost:8080/proxy/http://example.com/file?query=1
        var remoteUrl = getRemoteUrlFromParam(req);
        if (!remoteUrl) {
            // look for request like http://localhost:8080/proxy/?http%3A%2F%2Fexample.com%2Ffile%3Fquery%3D1
            remoteUrl = Object.keys(req.query)[0];
            if (remoteUrl) {
                remoteUrl = url.parse(remoteUrl);
            }
        }

        if (!remoteUrl) {
            return res.status(400).send('No url specified.');
        }

        if (!remoteUrl.protocol) {
            remoteUrl.protocol = 'http:';
        }

        var proxy;
        if (upstreamProxy && !(remoteUrl.host in bypassUpstreamProxyHosts)) {
            proxy = upstreamProxy;
        }

        // encoding : null means "body" passed to the callback will be raw bytes
        request.get({
            url: url.format(remoteUrl),
            headers: filterHeaders(req, req.headers),
            encoding: null,
            proxy: proxy
        }, function (error, response, body) {
            var code = 500;

            if (response) {
                code = response.statusCode;
                res.header(filterHeaders(req, response.headers));
            }

            res.status(code).send(body);
        });
    });

    var server = app.listen(argv.port, argv.public ? undefined : 'localhost', function () {
        if (argv.public) {
            console.log('Cesium development server running publicly.  Connect to http://localhost:%d/', server.address().port);
        } else {
            console.log('Cesium development server running locally.  Connect to http://localhost:%d/', server.address().port);
        }
    });

    // Server error handling
    server.on('error', function (e) {
        if (e.code === 'EADDRINUSE') {
            console.log('Error: Port %d is already in use, select a different port.', argv.port);
            console.log('Example: node server.js --port %d', argv.port + 1);
        } else if (e.code === 'EACCES') {
            console.log('Error: This process does not have permission to listen on port %d.', argv.port);
            if (argv.port < 1024) {
                console.log('Try a port number higher than 1024.');
            }
        }
        console.log(e);
        process.exit(1);
    });

    // Server closed
    server.on('close', function () {
        console.log('Cesium development server stopped.');
    });

    // Server forced close
    var isFirstSig = true;
    process.on('SIGINT', function () {
        if (isFirstSig) {
            console.log('Cesium development server shutting down.');
            server.close(function () {
                process.exit(0);
            });
            isFirstSig = false;
        } else {
            console.log('Cesium development server force kill.');
            process.exit(1);
        }
    });

})();
