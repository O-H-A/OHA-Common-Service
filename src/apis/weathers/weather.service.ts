import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  LoggerService,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { WeatherEntity } from './entities/weather.entity';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { NUM_OF_ROWS, PAGE_NO } from 'src/utils/constant';
import { KoreaDate } from 'src/utils/calculate-kst';
import { AvailableGrids } from 'src/utils/available-grids';
import { SkyType } from './enums/sky.enum';
import { PtyType } from './enums/pty.enum';
import { FreqDistrictEntity } from '../locations/entities/freq-district.entity';
import { LocationsService } from '../locations/locations.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

@Injectable()
export class WeathersService {
  constructor(
    @Inject(Logger)
    private readonly logger: LoggerService,
    @InjectRepository(WeatherEntity)
    private weatherRepository: Repository<WeatherEntity>,
    @InjectRepository(FreqDistrictEntity)
    private freqDistrictRepository: Repository<FreqDistrictEntity>,
    private readonly httpService: HttpService,
    private locationsService: LocationsService,
    private schedulerRegistery: SchedulerRegistry,
    private dataSource: DataSource,
  ) {
    this.insert();
  }

  async insert() {
    try {
      const name = 'InsertJob';
      const job = new CronJob('0 15 5,17 * * *', async () => {
        this.logger.verbose(`Start Insert!`, job.lastDate());
        await this.insertWeather();
      });
      this.schedulerRegistery.addCronJob(name, job);
    } catch (e) {
      this.logger.error(e);
      this.insert(); // 에러 발생했을 경우 처음부터 재시도
    }
  }

  private async insertWeather() {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const numOfRows = NUM_OF_ROWS;
      const pageNo = PAGE_NO;
      const koreaFullDate = new KoreaDate();
      const baseDate = koreaFullDate.getFullDate();

      let baseTime;
      if (parseInt(koreaFullDate.getFullTime().slice(0, 2), 10) >= 17) {
        baseTime = '1700';
      } else {
        baseTime = '0500';
      }

      const grids = AvailableGrids;

      while (grids.length !== 0) {
        const grid = grids.shift();
        const nx = grid.nx;
        const ny = grid.ny;
        const apiUrl = `http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=${process.env.WEATHER_KEY}&numOfRows=${numOfRows}&dataType=JSON&pageNo=${pageNo}&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;
        const res = await lastValueFrom(this.httpService.get(apiUrl));

        // // 0.5초 대기
        // await this.delay(500);

        const datas = res.data.response?.body.items.item;
        if (!datas) {
          grids.push(grid);
          continue;
        }
        const groupedData = datas.reduce((acc, item) => {
          const key = `${item.fcstDate}_${item.fcstTime}`;
          if (!acc[key]) {
            acc[key] = { fcstDate: item.fcstDate, fcstTime: item.fcstTime, nx: item.nx, ny: item.ny };
          }
          acc[key][item.category] = item.fcstValue;
          return acc;
        }, {});

        const dataArray = Object.values(groupedData);
        for (const data of dataArray) {
          const weatherData = new WeatherEntity();
          Object.assign(weatherData, data);
          await queryRunner.manager.save(weatherData);
        }
      }
      await queryRunner.commitTransaction();
      this.logger.verbose('InsertJob Finished!!');
      return;
    } catch (e) {
      await queryRunner.rollbackTransaction();
      this.logger.error(e);
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  async getWeatherDatas(userId: number) {
    const { code } = await this.freqDistrictRepository.findOne({
      select: { code: true },
      where: { userId, isDefault: true },
    });
    if (!code) {
      throw new NotFoundException('default인 지역이 없습니다');
    }
    const { nx, ny } = await this.locationsService.getGridByCode(code);
    const koreaFullDate = new KoreaDate();
    const currentDate = koreaFullDate.getFullDate();
    const currentHour = koreaFullDate.getFullTime().slice(0, 2);
    const weatherInfos = await this.weatherRepository.findOne({
      where: { fcstDate: currentDate, fcstTime: currentHour + '00', nx, ny },
    });
    if (!weatherInfos) {
      throw new NotFoundException('날씨 정보가 없습니다');
    }

    const { fcstDate, fcstTime, POP, PTY, REH, SKY, TMP, WSD } = weatherInfos;
    const date = fcstDate;
    const hour = fcstTime;
    const precipPercent = POP;
    const precipType = await this.getPtyType(PTY);
    const humidity = REH;
    const sky = await this.getSkyType(SKY);
    const hourlyTemp = TMP;
    const windSpeed = WSD;
    return { date, hour, precipPercent, precipType, humidity, sky, hourlyTemp, windSpeed };
  }

  private async getSkyType(sky: string) {
    if (sky === '1') {
      return SkyType.clear;
    } else if (sky === '3') {
      return SkyType.mostlyCloudy;
    } else if (sky === '4') {
      return SkyType.cloudy;
    } else {
      return 'No Provided';
    }
  }

  private async getPtyType(pty: string) {
    if (pty === '0') {
      return PtyType.dry;
    } else if (pty === '1') {
      return PtyType.rain;
    } else if (pty === '2') {
      return PtyType.sleet;
    } else if (pty === '3') {
      return PtyType.snow;
    } else if (pty === '4') {
      return PtyType.shower;
    } else {
      return 'No Provided';
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
