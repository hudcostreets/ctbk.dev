# [ctbk.dev](https://ctbk.dev/) Citi Bike Dashboard

- [ctbk/](ctbk) contains a Python library and CLI (`ctbk`) that derives various datasets from Citi Bike's public data at [`s3://tripdata`]
- [s3://ctbk] contains cleaned, public data output by [`ctbk`]
- [www/](www) contains the static web app served at [ctbk.dev].
- GitHub Actions in [.github/workflows](.github/workflows):
  - poll for new Citi Bike data at the start of each month
  - compute new derived data when found, and
  - build and publish the [ctbk.dev] website

## Screenshots <a id="screenshots"></a>
[ctbk.dev]:

[![Screenshot of dashboard; per-month ride counts going back to June 2013, with a 12mo rolling avg showing mostly steady growth](www/public/screenshots/ctbk-rides.png)][ctbk.dev]

### Station/Ridership Map <a id="ctbk-stations"></a>
[ctbk.dev/stations]:

[![Map of Citi Bike stations, Hoboken NJ Transit Terminal selected, showing destinations for rides beginning there](www/public/screenshots/ctbk-stations.png)][ctbk.dev/stations]

### JC & Hoboken Only <a id="ctbk-nj"></a>
[ctbk.dev/?r=jh][ctbk nj plot]:

[![Screenshot of dashboard; per-month ride counts for Jersey City and Hoboken only, going back to June 2013, with a 12mo rolling avg showing mostly steady growth](www/public/screenshots/ctbk-nj.png)][ctbk nj plot]

### Ride Minute %'s by Gender <a id="ctbk-ride-minutes-by-gender"></a>
[ctbk.dev?d=1406-2102&g=mf&pct&s=g&y=m][ctbk gender pct plot]:

[![](www/public/screenshots/ctbk-ride-minutes-by-gender.png)][ctbk gender pct plot]
(Gender labels stopped appearing in the data in February 2021)

### Ride %'s by User Type <a id="ctbk-rides-by-user"></a>
[ctbk.dev/?s=u&pct=][ctbk user type pct plot]:

[![](www/public/screenshots/ctbk-rides-by-user.png)][ctbk user type pct plot]

### Total Classic / E-bike Ride Minutes <a id="ctbk-ebike-minutes"></a>
[ctbk.dev?y=m&s=b&rt=ce&d=2002-][ctbk ebike minutes plot]:

[![](www/public/screenshots/ctbk-ebike-minutes.png)][ctbk ebike minutes plot]

### Stations by launch date <a id="stations-by-creation-date"></a>
This is a work-in-progress; red = newer, yellow = older:

![](www/public/img/stations-by-creation-date.png)

### E-bike minutes by user type <a id="ctbk-ebike-minutes-by-user"></a>
[ctbk.dev/?y=m&s=u&rt=e&d=2002-][ctbk ebike minutes by user plot]:

[![](www/public/screenshots/ctbk-ebike-minutes-by-user.png)][ctbk ebike minutes by user plot]

You can get some interesting upper bounds on e-bike fee revenue from this:
- 6MM "member" e-bike minutes @ [$0.16/min][citi bike member pricing] ⟹ ≈$1MM
- 3MM "casual" e-bike minutes @ [$0.26/min][citi bike day pricing] ⟹$750k

That doesn't count various reasons that e-bike minutes end up being free (positive bike angel points for the ride, no classic bikes available at station, etc.). With the discussion around recent price increases, you can do some envelope math like:
- Suppose an e-bike costs $1000 (probably a low-ball estimate)
- Suppose [10 rides per e-bike per day][citi ebike rides per day], and avg. 15mins / ride ⟹ $30 in e-bike fees per e-bike per day ⟹ 1-2 months to break even on each e-bike, *before accounting for any operational cost of maintaining the e-bike fleet.* Most likely the bikes don't break even for years, I'd guess…

### Ride Durations
This isn't live anywhere yet, but:
![](www/public/img/ride_durations_202303_10s.png)

The peak of the distribution (rounded down to the nearest 10s) is 4m20s. See [notebook here](nbs/ride-lengths.ipynb).

## Prior Art <a id="prior-art"></a>
[Many][ckran-20210305] [great][toddschneider-20160113] [analyses][jc-analysis-2017] [of][jc-analysis-2018] [Citi Bike][datastudio-analysis] [data][cl2871-analysis] [have][tableau #citibike] [been][coursera citibike viz course] [done][juanjocarin analysis] [over][clif-kranish-20210125] [the][clif-kranish-20210210] years!

My hope is that this dashboard will:
- stay up to date automatically
- support enough exploratory data analysis and visualization to answer most q's a layperson might have about system-wide stats

## Feedback / Contributing <a id="feedback"></a>
Feel free to [file an issue here][github new issue] with any comments, bug reports, or feedback!

[ckran-20210305]: https://towardsdatascience.com/exploring-the-effects-of-the-pandemic-on-nyc-bike-share-usage-ab79f67ac2df
[toddschneider-20160113]: https://toddwschneider.com/posts/a-tale-of-twenty-two-million-citi-bikes-analyzing-the-nyc-bike-share-system/
[clif-kranish-20210125]: https://towardsdatascience.com/exploring-bike-share-data-3e3b2f28760c
[clif-kranish-20210210]: https://towardsdatascience.com/reverse-geocoding-with-nyc-bike-share-data-cdef427987f8
[jc-analysis-2017]: https://www.bikejc.org/resources/citibikejc-2017
[jc-analysis-2018]: https://www.bikejc.org/citi-bike-usage-jersey-city-2018
[datastudio-analysis]: https://datastudio.google.com/u/0/reporting/a6fc910f-b100-4ac5-a72b-2fa35880f149/page/SKniB
[cl2871-analysis]: https://github.com/cl2871/citibike
[tableau #citibike]: https://public.tableau.com/en-gb/search/all/%23CitiBike
[coursera citibike viz course]: https://www.coursera.org/projects/visualizing-citibike-trips-tableau
[juanjocarin analysis]: http://juanjocarin.github.io/Citibike-viz/

[citibike system data]: https://www.citibikenyc.com/system-data
[Parquet]: https://parquet.apache.org/

[`s3://tripdata`]: https://s3.amazonaws.com/tripdata/index.html
[`s3://ctbk`]: https://ctbk.s3.amazonaws.com/index.html
[s3://ctbk]: https://ctbk.s3.amazonaws.com/index.html

[github actions]: https://github.com/hudcostreets/ctbk.dev/actions
[github issues]: https://github.com/hudcostreets/ctbk.dev/issues
[github new issue]: https://github.com/hudcostreets/ctbk.dev/issues/new

[`ctbk`]: ctbk
[ctbk.dev]: https://ctbk.dev/
[ctbk gender pct plot]: https://ctbk.dev/?y=m&s=g&pct=&g=mf&d=1406-2102
[ctbk.dev/stations]: https://ctbk.dev/stations?ll=40.733_-74.036&z=14&ss=HB102
[ctbk nj plot]: https://ctbk.dev/?r=jh
[ctbk user type pct plot]: https://ctbk.dev/?s=u&pct=
[ctbk ebike minutes plot]: https://ctbk.dev?y=m&s=b&rt=ce&d=2002-
[ctbk ebike minutes by user plot]: https://ctbk.dev/?y=m&s=u&rt=e&d=2002-
[citi bike day pricing]: https://citibikenyc.com/pricing/day
[citi bike member pricing]: https://citibikenyc.com/pricing/annual
[citi ebike rides per day]: https://ride.citibikenyc.com/blog/ridershiprecords#:~:text=Our%20ebikes%20are%20seeing%20more%20than%2010%20rides%20per%20bike%20per%20day
