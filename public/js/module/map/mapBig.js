/*global requirejs:true, require:true, define:true*/
/**
 * Модель карты
 */
define([
    'underscore', 'Browser', 'Utils', 'socket', 'Params', 'knockout', 'knockout.mapping', 'm/_moduleCliche', 'globalVM', 'renderer',
    'm/User', 'm/storage',
    'leaflet', 'lib/leaflet/extends/L.neoMap', 'm/map/navSlider', 'Locations',
    'text!tpl/map/mapBig.jade', 'css!style/map/mapBig'
], function (_, Browser, Utils, socket, P, ko, ko_mapping, Cliche, globalVM, renderer, User, storage, L, Map, NavigationSlider, Locations, jade) {
    'use strict';
    var $window = $(window);

    return Cliche.extend({
        jade: jade,
        create: function () {
            this.auth = globalVM.repository['m/auth'];
            this.map = null;
            this.mapDefCenter = null;
            this.layers = ko.observableArray();
            this.layersOpen = ko.observable(false);
            this.layerActive = ko.observable({sys: null, type: null});
            this.layerActiveDesc = ko.observable('');

            if (P.settings.USE_OSM_API()) {
                this.layers.push({
                    id: 'osm',
                    desc: 'OSM',
                    selected: ko.observable(false),
                    types: ko.observableArray([
                        {
                            id: 'osmosnimki',
                            desc: 'Osmosnimki',
                            selected: ko.observable(false),
                            obj: new L.TileLayer('http://{s}.tile.osmosnimki.ru/kosmo/{z}/{x}/{y}.png', {updateWhenIdle: false})
                        },
                        {
                            id: 'mapnik',
                            desc: 'Mapnik',
                            selected: ko.observable(false),
                            obj: new L.TileLayer('http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {updateWhenIdle: false})
                        },
                        {
                            id: 'mapquest',
                            desc: 'Mapquest',
                            selected: ko.observable(false),
                            obj: new L.TileLayer('http://otile1.mqcdn.com/tiles/1.0.0/osm/{z}/{x}/{y}.png', {updateWhenIdle: false})
                        }
                    ])
                });
            }
            if (P.settings.USE_GOOGLE_API()) {
                this.layers.push({
                    id: 'google',
                    desc: 'Google',
                    deps: 'lib/leaflet/extends/L.Google',
                    selected: ko.observable(false),
                    types: ko.observableArray([
                        {
                            id: 'scheme',
                            desc: 'Схема',
                            selected: ko.observable(false),
                            params: 'ROADMAP'
                        },
                        {
                            id: 'sat',
                            desc: 'Спутник',
                            selected: ko.observable(false),
                            params: 'SATELLITE'
                        },
                        {
                            id: 'hyb',
                            desc: 'Гибрид',
                            selected: ko.observable(false),
                            params: 'HYBRID'
                        },
                        {
                            id: 'land',
                            desc: 'Ландшафт',
                            selected: ko.observable(false),
                            params: 'TERRAIN'
                        }
                    ])
                });
            }
            if (P.settings.USE_YANDEX_API()) {
                this.layers.push({
                    id: 'yandex',
                    desc: 'Яндекс',
                    deps: 'lib/leaflet/extends/L.Yandex',
                    selected: ko.observable(false),
                    types: ko.observableArray([
                        {
                            id: 'scheme',
                            desc: 'Схема',
                            selected: ko.observable(false),
                            params: 'map'
                        },
                        {
                            id: 'sat',
                            desc: 'Спутник',
                            selected: ko.observable(false),
                            params: 'satellite'
                        },
                        {
                            id: 'hyb',
                            desc: 'Гибрид',
                            selected: ko.observable(false),
                            params: 'hybrid'
                        },
                        {
                            id: 'pub',
                            desc: 'Народная',
                            selected: ko.observable(false),
                            params: 'publicMap'
                        },
                        {
                            id: 'pubhyb',
                            desc: 'Народный гибрид',
                            selected: ko.observable(false),
                            params: 'publicMapHybrid'
                        }
                    ])
                });
            }

            ko.applyBindings(globalVM, this.$dom[0]);

            this.show();
        },
        show: function () {
            this.$container.fadeIn(400, function () {

                this.mapDefCenter = new L.LatLng(Locations.current.lat, Locations.current.lng);
                this.map = new L.neoMap('map', {center: this.mapDefCenter, zoom: Locations.current.z, minZoom: 0, maxZoom: 18, zoomAnimation: true, trackResize: false});

                //this.navSlider = new NavigationSlider(this.$dom.find('#nav_slider_area')[0], this.map);

                Locations.subscribe(function (val) {
                    this.mapDefCenter = new L.LatLng(val.lat, val.lng);
                    this.setMapDefCenter(true);
                }.bind(this));

                //Самостоятельно обновлем размеры карты
                P.window.square.subscribe(function (newVal) {
                    this.map._onResize();
                }.bind(this));

                this.map.whenReady(function () {
                    this.selectLayer('osm', 'mapnik');
                }, this);

                renderer(
                    [
                        {module: 'm/map/navSlider', container: '.mapNavigation', options: {map: this.map}, ctx: this, callback: function (vm) {
                            this.navSlider = vm;
                        }.bind(this)}
                    ],
                    {
                        parent: this,
                        level: this.level + 1
                    }
                );

            }.bind(this));

            this.showing = true;
        },
        hide: function () {
            this.$container.css('display', '');
            this.showing = false;
        },
        setMapDefCenter: function (forceMoveEvent) {
            this.map.setView(this.mapDefCenter, Locations.current.z, false);
        },
        toggleLayers: function (vm, event) {
            this.layersOpen(!this.layersOpen());
        },
        selectLayer: function (sys_id, type_id) {
            var layers = this.layers(),
                layerActive = this.layerActive(),
                system,
                type;

            if (layerActive.sys && layerActive.sys.id === sys_id && layerActive.type.id === type_id) { return; }

            system = _.find(layers, function (item) { return item.id === sys_id; });

            if (system) {
                type = _.find(system.types(), function (item) { return item.id === type_id; });

                if (type) {
                    if (layerActive.sys && layerActive.type) {
                        layerActive.sys.selected(false);
                        layerActive.type.selected(false);
                        this.map.removeLayer(layerActive.type.obj);
                    }

                    system.selected(true);
                    type.selected(true);
                    this.layerActiveDesc(system.desc + ': ' + type.desc);

                    /*if (!!window.localStorage) {
                     window.localStorage['arguments.SelectLayer'] = Array.prototype.slice.call(arguments).join(',');
                     }*/
                    this.layerActive({sys: system, type: type});

                    if (system.deps && !type.obj) {
                        require([system.deps], function (Construct) {
                            type.obj = new Construct(type.params);
                            this.map.addLayer(type.obj);
                            type = null;
                        }.bind(this));
                    } else {
                        this.map.addLayer(type.obj);
                    }
                }
            }

            layers = system = null;
        }
    });
});