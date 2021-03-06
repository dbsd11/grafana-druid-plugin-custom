/*
 * Copyright 2014-2015 Quantiply Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
define([
  'angular',
  'lodash',
  'app/core/utils/datemath',
  'moment',
],
function (angular, _, dateMath, moment) {
  'use strict';

  /** @ngInject */
  function DruidDatasource(instanceSettings, $q, backendSrv, templateSrv) {
    this.type = 'druid-datasource';
    this.url = instanceSettings.url;
    this.name = instanceSettings.name;
    this.basicAuth = instanceSettings.basicAuth;
    instanceSettings.jsonData = instanceSettings.jsonData || {};
    this.supportMetrics = true;
    this.periodGranularity = instanceSettings.jsonData.periodGranularity;

    this.rawFilter = null;
    this.rawAggregators = null;
    this.rawPostAggregators = null;

    function replaceTemplateValues(obj, attrList) {
      var substitutedVals = attrList.map(function (attr) {
        return templateSrv.replace(obj[attr]);
      });
      return _.assign(_.clone(obj, true), _.zipObject(attrList, substitutedVals));
    }

    var GRANULARITIES = [
      ['minute', moment.duration(1, 'minute')],
      ['fifteen_minute', moment.duration(15, 'minute')],
      ['thirty_minute', moment.duration(30, 'minute')],
      ['hour', moment.duration(1, 'hour')],
      ['day', moment.duration(1, 'day')]
    ];

    var filterTemplateExpanders = {
      "selector": _.partialRight(replaceTemplateValues, ['value']),
      "regex": _.partialRight(replaceTemplateValues, ['pattern']),
      "javascript": _.partialRight(replaceTemplateValues, ['function']),
      "search": _.partialRight(replaceTemplateValues, []),
    };

    this.testDatasource = function() {
      return this._get('/druid/v2/datasources').then(function () {
        return { status: "success", message: "Druid Data source is working", title: "Success" };
      });
    };

    //Get list of available datasources
    this.getDataSources = function() {
      return this._get('/druid/v2/datasources').then(function (response) {
        return response.data;
      });
    };

    this.getDimensionsAndMetrics = function (datasource) {
      return this._get('/druid/v2/datasources/'+ datasource).then(function (response) {
        return response.data;
      });
    };

    this.getRawQuery = function (rawQuery, panelRange, query) {
      try {
        var jsonRawQuery = JSON.parse(rawQuery);
      } catch (error) {
        
      }
      if (jsonRawQuery) {
        jsonRawQuery.intervals = getQueryIntervals(panelRange.from, panelRange.to);
        return this._druidQuery(jsonRawQuery);
      }
    }

    this.getLucaSQL = function (sql, query) {
      return this._druidSQLQuery(sql);
    }

    this.getFilterValues = function (target, panelRange, query) {
        var topNquery = {
            "queryType": "topN",
            "dataSource": target.druidDS,
            "granularity": 'all',
            "threshold": 10,
            "dimension": target.currentFilter.dimension,
            "metric": "count",
            "aggregations": [{ "type" : "count", "name" : "count" }],
            "intervals" : getQueryIntervals(panelRange.from, panelRange.to)
        };

        var filters = [];
        if(target.filters){
            filters = angular.copy(target.filters);
        }
        filters.push({
            "type": "search",
            "dimension": target.currentFilter.dimension,
            "query": {
                "type": "insensitive_contains",
                "value": query
            }
        });
        topNquery.filter = buildFilterTree(filters);

        return this._druidQuery(topNquery);
    };

    this._get = function(relativeUrl, params) {
      return backendSrv.datasourceRequest({
        method: 'GET',
        url: this.url + relativeUrl,
        params: params,
      });
    };

    this.setRawFilter = function(rawFilter, query) {
      try {
        this.rawFilter = JSON.parse(rawFilter);
      } catch (error) {
        console.error("Filter 格式解析错误");
        console.error(error);
      }
    }

    this.setRawAggregators = function(rawAggregators, query) {
      try {
        this.rawAggregators = JSON.parse(rawAggregators);
      } catch (error) {
        console.error("aggregations 格式解析错误");
        console.error(error);
      }
    };

    this.setRawPostAggregator = function(rawPostAggregators, query) {
      try {
        this.rawPostAggregators = JSON.parse(rawPostAggregators);
      } catch (error) {
        console.error("post agg 格式解析错误");
        console.error(error);
      }
    };

    // Called once per panel (graph)
    this.query = function(options) {
      var dataSource = this;
      var from = dateToMoment(options.range.from, false);
      var to = dateToMoment(options.range.to, true);

      console.log("Do query");
      console.log(options);

      var promises = options.targets.map(function (target) {
        if (target.hide===true || _.isEmpty(target.druidDS) || ((_.isEmpty(target.currentLucaSQL) && _.isEmpty(target.currentRawQuery) && _.isEmpty(target.currentRawAggregator) && _.isEmpty(target.aggregators)) && target.queryType !== "select")) {
          console.log("target.hide: " + target.hide + ", target.druidDS: " + target.druidDS + ", target.aggregators: " + target.aggregators);
          var d = $q.defer();
          d.resolve([]);
          return d.promise;
        }
        var maxDataPointsByResolution = options.maxDataPoints;
        var maxDataPointsByConfig = target.maxDataPoints? target.maxDataPoints : Number.MAX_VALUE;
        var maxDataPoints = Math.min(maxDataPointsByResolution, maxDataPointsByConfig);
        var granularity = target.shouldOverrideGranularity? target.customGranularity : computeGranularity(from, to, maxDataPoints);
        //Round up to start of an interval
        //Width of bar chars in Grafana is determined by size of the smallest interval
        var roundedFrom = granularity === "all" ? from : roundUpStartTime(from, granularity);
        if(dataSource.periodGranularity!=""){
            if(granularity==='day'){
                granularity = {"type": "period", "period": "P1D", "timeZone": dataSource.periodGranularity}
            }
        }
        return dataSource._doQuery(roundedFrom, to, granularity, target);
      });

      return $q.all(promises).then(function(results) {
        return { data: _.flatten(results) };
      });
    };

    this._doQuery = function (from, to, granularity, target) {
      var datasource = target.druidDS;
      
      var rawQuery = null;
      try {
        rawQuery = target.currentRawQuery || target.rawQuery;
        rawQuery = JSON.parse(rawQuery);
      } catch (error) {
        rawQuery = null;
      }

      var lucaSQL = null;
      lucaSQL = target.currentLucaSQL;

      var rawFilter = null;
      try {
        rawFilter = target.currentRawFilter;
        rawFilter = JSON.parse(rawFilter);
      } catch (error) {
        rawFilter = null;
      }
      var filters = target.filters;
      if (filters && rawFilter) {
        filters = filters.concat(rawFilter);
      } else if (rawFilter) {
        filters = rawFilter;
      }
      
      var rawAggregators = null;
      try {
        rawAggregators = target.currentRawAggregator;
        rawAggregators = JSON.parse(rawAggregators);
      } catch (error) {
        rawAggregators = null;
      }
      var aggregators = target.aggregators;
      if (aggregators && rawAggregators) {
        aggregators = aggregators.concat(rawAggregators);
      } else if (rawAggregators) {
        aggregators = rawAggregators;
      }

      var rawPostAggregators = null;
      try {
        rawPostAggregators = target.currentRawPostAggregator;
        rawPostAggregators = JSON.parse(rawPostAggregators);
      } catch (error) {
        rawPostAggregators = null;
      }
      var postAggregators = rawPostAggregators || target.postAggregators;

      var groupBy = _.map(target.groupBy, (e) => { return templateSrv.replace(e) });
      var limitSpec = null;
      var metricNames = getMetricNames(aggregators, postAggregators);
      var intervals = getQueryIntervals(from, to);
      var promise = null;

      var selectMetrics = target.selectMetrics;
      var selectDimensions = target.selectDimensions;
      var selectThreshold = target.selectThreshold;
      if(!selectThreshold) {
        selectThreshold = 5;
      }

      if (lucaSQL) {
        lucaSQL = templateSrv.replace(lucaSQL)
        promise = this._sqlQuery(lucaSQL)
        return promise.then(function(response) {
          var dimensionsObj={}
          var events=[]
          var i=0;
          response.data.forEach(function(v){
             _.extend(dimensionsObj, v)
             if(!v["timestamp"]){
               v["timestamp"]=v["__time"]?new Date(v["__time"]).getTime():new Date(new Date().getTime()-10*60*1000).toISOString()
             }
             events.push({"event":v, "offset":i++,"segmentId":'noSegment'})
          })
          var sqlGroupByData = _.map(events, 'event').map(function(v){
             return {"timestamp":v["timestamp"], "event":v}
          })
          return convertGroupByData(sqlGroupByData,groupBy,metricNames)
        });
      } else if (rawQuery) {
        rawQuery.intervals = intervals
        promise = this._rawQuery(rawQuery)
      } else if (target.queryType === 'topN') {
        var threshold = target.limit;
        var metric = target.druidMetric;
        var dimension = templateSrv.replace(target.dimension);
        promise = this._topNQuery(datasource, intervals, granularity, filters, aggregators, postAggregators, threshold, metric, dimension)
          .then(function(response) {
            return convertTopNData(response.data, dimension, metric);
          });
      }
      else if (target.queryType === 'groupBy') {
        limitSpec = getLimitSpec(target.limit, target.orderBy);
        promise = this._groupByQuery(datasource, intervals, granularity, filters, aggregators, postAggregators, groupBy, limitSpec)
          .then(function(response) {
            return convertGroupByData(response.data, groupBy, metricNames);
          });
      }
      else if (target.queryType === 'select') {
        promise = this._selectQuery(datasource, intervals, granularity, selectDimensions, selectMetrics, filters, selectThreshold);
        return promise.then(function(response) {
          return convertSelectData(response.data);
        });
      }
      else {
        promise = this._timeSeriesQuery(datasource, intervals, granularity, filters, aggregators, postAggregators)
          .then(function(response) {
            return convertTimeSeriesData(response.data, metricNames);
          });
      }
      /*
        At this point the promise will return an list of time series of this form
      [
        {
          target: <metric name>,
          datapoints: [
            [<metric value>, <timestamp in ms>],
            ...
          ]
        },
        ...
      ]

      Druid calculates metrics based on the intervals specified in the query but returns a timestamp rounded down.
      We need to adjust the first timestamp in each time series
      */
      return promise.then(function (metrics) {
        var fromMs = formatTimestamp(from);
        metrics.forEach(function (metric) {
          if (!_.isEmpty(metric.datapoints[0]) && metric.datapoints[0][1] < fromMs) {
            metric.datapoints[0][1] = fromMs;
          }
        });
        return metrics;
      });
    };

    this._selectQuery = function (datasource, intervals, granularity, dimension, metric, filters, selectThreshold) {
      var query = {
        "queryType": "select",
        "dataSource": datasource,
        "granularity": granularity,
        "pagingSpec": {"pagingIdentifiers": {}, "threshold": selectThreshold},
        "dimensions": dimension,
        "metrics": metric,
        "intervals": intervals
      };

      if (filters && filters.length > 0) {
        query.filter = buildFilterTree(filters);
      }

      return this._druidQuery(query);
    };

    this._timeSeriesQuery = function (datasource, intervals, granularity, filters, aggregators, postAggregators) {
      var query = {
        "queryType": "timeseries",
        "dataSource": datasource,
        "granularity": granularity,
        "aggregations": aggregators,
        "postAggregations": postAggregators,
        "intervals": intervals
      };

      if (filters && filters.length > 0) {
        query.filter = buildFilterTree(filters);
      }

      return this._druidQuery(query);
    };

    this._topNQuery = function (datasource, intervals, granularity, filters, aggregators, postAggregators,
    threshold, metric, dimension) {
      var query = {
        "queryType": "topN",
        "dataSource": datasource,
        "granularity": granularity,
        "threshold": threshold,
        "dimension": dimension,
        "metric": metric,
        // "metric": {type: "inverted", metric: metric},
        "aggregations": aggregators,
        "postAggregations": postAggregators,
        "intervals": intervals
      };

      if (filters && filters.length > 0) {
        query.filter = buildFilterTree(filters);
      }

      return this._druidQuery(query);
    };

    this._groupByQuery = function (datasource, intervals, granularity, filters, aggregators, postAggregators,
    groupBy, limitSpec) {
      var query = {
        "queryType": "groupBy",
        "dataSource": datasource,
        "granularity": granularity,
        "dimensions": groupBy,
        "aggregations": aggregators,
        "postAggregations": postAggregators,
        "intervals": intervals,
        "limitSpec": limitSpec
      };

      if (filters && filters.length > 0) {
        query.filter = buildFilterTree(filters);
      }

      return this._druidQuery(query);
    };

    this._rawQuery = function (query) {
      return this._druidQuery(query);
    }

    this._sqlQuery = function (sql) {
      return this._druidSQLQuery(sql);
    }

    this._druidQuery = function (query) {
      const tmpQuery = JSON.parse(JSON.stringify(query));
      // if (this.rawAggregators) {
      //   tmpQuery.aggregations = tmpQuery.aggregations.concat(this.rawAggregators);
      // }
      if (this.rawPostAggregators) {
        tmpQuery.postAggregations = this.rawPostAggregators;
      }
      var options = {
        method: 'POST',
        url: this.url + '/druid/v2/',
        data: tmpQuery
      };
      console.log("Make http request");
      console.log(options);
      return backendSrv.datasourceRequest(options);
    };

    this._druidSQLQuery = function (sql) {
      var options = {
        method: 'POST',
        url: this.url + '/druid/v2/sql',
        data: {
          query: sql,
          resultFormat: 'object',
          header: true
        }
      };
      return backendSrv.datasourceRequest(options);
    };

    function getLimitSpec(limitNum, orderBy) {
      return {
        "type": "default",
        "limit": limitNum,
        "columns": !orderBy? null: orderBy.map(function (col) {
          return {"dimension": col, "direction": "DESCENDING"};
        })
      };
    }

    function buildFilterTree(filters) {
      //Do template variable replacement
      var replacedFilters = filters.map(function (filter) {
        if (filterTemplateExpanders.hasOwnProperty(filter.type)) {
          return filterTemplateExpanders[filter.type](filter);
        } else {
          return filterTemplateExpanders['search'](filter);
        }
      })
      .map(function (filter) {
        var finalFilter = _.omit(filter, 'negate');
        if (filter.negate) {
          return { "type": "not", "field": finalFilter };
        }
        return finalFilter;
      });
      if (replacedFilters) {
        if (replacedFilters.length === 1) {
          return replacedFilters[0];
        }
        return  {
          "type": "and",
          "fields": replacedFilters
        };
      }
      return null;
    }

    function getQueryIntervals(from, to) {
      return [from.toISOString() + '/' + to.toISOString()];
    }

    function getMetricNames(aggregators, postAggregators) {
      var displayAggs = _.filter(aggregators, function (agg) {
        return agg.type !== 'approxHistogramFold' && agg.hidden != true;
      });
      return _.union(_.map(displayAggs, 'name'), _.map(postAggregators, 'name'));
    }

    function formatTimestamp(ts) {
      return moment(ts).format('X')*1000;
    }

    function convertTimeSeriesData(md, metrics) {
      return metrics.map(function (metric) {
        return {
          target: metric,
          datapoints: md.map(function (item) {
            return [
              item.result[metric],
              formatTimestamp(item.timestamp)
            ];
          })
        };
      });
    }

    function getGroupName(groupBy, metric) {
      return groupBy.map(function (dim) {
        return metric.event[dim];
      })
      .join("-");
    }

    function convertTopNData(md, dimension, metric) {
      /*
        Druid topN results look like this:
        [
          {
            "timestamp": "ts1",
            "result": [
              {"<dim>": d1, "<metric>": mv1},
              {"<dim>": d2, "<metric>": mv2}
            ]
          },
          {
            "timestamp": "ts2",
            "result": [
              {"<dim>": d1, "<metric>": mv3},
              {"<dim>": d2, "<metric>": mv4}
            ]
          },
          ...
        ]
      */

      /*
        First, we need make sure that the result for each
        timestamp contains entries for all distinct dimension values
        in the entire list of results.

        Otherwise, if we do a stacked bar chart, Grafana doesn't sum
        the metrics correctly.
      */

      //Get the list of all distinct dimension values for the entire result set
      var dVals = md.reduce(function (dValsSoFar, tsItem) {
        var dValsForTs = _.map(tsItem.result, dimension);
        return _.union(dValsSoFar, dValsForTs);
      }, {});

      //Add null for the metric for any missing dimension values per timestamp result
      md.forEach(function (tsItem) {
        var dValsPresent = _.map(tsItem.result, dimension);
        var dValsMissing = _.difference(dVals, dValsPresent);
        dValsMissing.forEach(function (dVal) {
          var nullPoint = {};
          nullPoint[dimension] = dVal;
          nullPoint[metric] = null;
          tsItem.result.push(nullPoint);
        });
        return tsItem;
      });

      //Re-index the results by dimension value instead of time interval
      var mergedData = md.map(function (item) {
        /*
          This first map() transforms this into a list of objects
          where the keys are dimension values
          and the values are [metricValue, unixTime] so that we get this:
            [
              {
                "d1": [mv1, ts1],
                "d2": [mv2, ts1]
              },
              {
                "d1": [mv3, ts2],
                "d2": [mv4, ts2]
              },
              ...
            ]
        */
        var timestamp = formatTimestamp(item.timestamp);
        var keys = _.map(item.result, dimension);
        var vals = _.map(item.result, metric).map(function (val) { return [val, timestamp];});
        return _.zipObject(keys, vals);
      })
      .reduce(function (prev, curr) {
        /*
          Reduce() collapses all of the mapped objects into a single
          object.  The keys are dimension values
          and the values are arrays of all the values for the same key.
          The _.assign() function merges objects together and it's callback
          gets invoked for every key,value pair in the source (2nd argument).
          Since our initial value for reduce() is an empty object,
          the _.assign() callback will get called for every new val
          that we add to the final object.
        */
        return _.assignWith(prev, curr, function (pVal, cVal) {
          if (pVal) {
            pVal.push(cVal);
            return pVal;
          }
          return [cVal];
        });
      }, {});

      //Convert object keyed by dimension values into an array
      //of objects {target: <dimVal>, datapoints: <metric time series>}
      return _.map(mergedData, function (vals, key) {
        return {
          target: key,
          datapoints: vals
        };
      });
    }

    function convertGroupByData(md, groupBy, metrics) {
      var mergedData = md.map(function (item) {
        /*
          The first map() transforms the list Druid events into a list of objects
          with keys of the form "<groupName>:<metric>" and values
          of the form [metricValue, unixTime]
        */
        var groupName = getGroupName(groupBy, item);
        var keys = metrics.map(function (metric) {
          return groupName + ":" + metric;
        });
        var vals = metrics.map(function (metric) {
          return [
            item.event[metric],
            formatTimestamp(item.timestamp)
          ];
        });
        return _.zipObject(keys, vals);
      })
      .reduce(function (prev, curr) {
        /*
          Reduce() collapses all of the mapped objects into a single
          object.  The keys are still of the form "<groupName>:<metric>"
          and the values are arrays of all the values for the same key.
          The _.assign() function merges objects together and it's callback
          gets invoked for every key,value pair in the source (2nd argument).
          Since our initial value for reduce() is an empty object,
          the _.assign() callback will get called for every new val
          that we add to the final object.
        */
        return _.assignWith(prev, curr, function (pVal, cVal) {
          if (pVal) {
            pVal.push(cVal);
            return pVal;
          }
          return [cVal];
        });
      }, {});

      return _.map(mergedData, function (vals, key) {
        /*
          Second map converts the aggregated object into an array
        */
        return {
          target: key,
          datapoints: vals
        };
      });
    }

    function convertSelectData(data){
      var resultList = _.map(data, "result");
      var eventsList = _.map(resultList, "events");
      var eventList = _.flatten(eventsList);
      var result = {};
      for(var i = 0; i < eventList.length; i++){
        var event = eventList[i].event;
        var timestamp = event.timestamp;
        if(_.isEmpty(timestamp)) {
          continue;
        }
        for(var key in event) {
          if(key !== "timestamp") {
            if(!result[key]){
              result[key] = {"target":key, "datapoints":[]};
            }
            result[key].datapoints.push([event[key], timestamp]);
          }
        }
      }
      return _.values(result);
    }

    function dateToMoment(date, roundUp) {
      if (date === 'now') {
        return moment();
      }
      date = dateMath.parse(date, roundUp);
      return moment(date.valueOf());
    }

    function computeGranularity(from, to, maxDataPoints) {
      var intervalSecs = to.unix() - from.unix();
      /*
        Find the smallest granularity for which there
        will be fewer than maxDataPoints
      */
      var granularityEntry = _.find(GRANULARITIES, function(gEntry) {
        return Math.ceil(intervalSecs/gEntry[1].asSeconds()) <= maxDataPoints;
      });

      console.log("Calculated \"" + granularityEntry[0]  +  "\" granularity [" + Math.ceil(intervalSecs/granularityEntry[1].asSeconds()) +
      " pts]" + " for " + (intervalSecs/60).toFixed(0) + " minutes and max of " + maxDataPoints + " data points");
      return granularityEntry[0];
    }

    function roundUpStartTime(from, granularity) {
      var duration = _.find(GRANULARITIES, function (gEntry) {
        return gEntry[0] === granularity;
      })[1];
      var rounded = null;
      if(granularity==='day'){
        rounded = moment(+from).startOf('day');
      }else{
        rounded = moment(Math.ceil((+from)/(+duration)) * (+duration));
      }
      console.log("Rounding up start time from " + from.format() + " to " + rounded.format() + " for granularity [" + granularity + "]");
      return rounded;
    }

   //changes druid end
  }
  return {
    DruidDatasource: DruidDatasource
  };
});
