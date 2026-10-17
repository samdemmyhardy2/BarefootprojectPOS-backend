import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { Role } from 'prisma/generated/prisma/enums';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesService } from './employees.service';

class ShiftQueryDto { @IsOptional() @IsUUID() employeeId?: string; }

@ApiTags('Employees') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}
  @Get('roles') @Roles(Role.ADMIN) @ApiOperation({ summary: 'List employee job roles for admin forms' }) @ApiResponse({ status: 200, description: 'Available restaurant job roles. Admin only.' })
  roles() { return this.employees.positions(); }
  @Get() @Roles(Role.ADMIN) @ApiOperation({ summary: 'List employees (admin)' }) @ApiResponse({ status: 200, description: 'Employees returned without password hashes.' })
  list() { return this.employees.list(); }
  @Post() @Roles(Role.ADMIN) @ApiOperation({ summary: 'Create an employee (admin)' }) @ApiResponse({ status: 201, description: 'Employee created.' }) @ApiConflictResponse({ description: 'Email already exists.' }) @ApiBadRequestResponse({ description: 'Invalid employee details.' })
  create(@Body() dto: CreateEmployeeDto) { return this.employees.create(dto); }
  @Patch(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Update an employee (admin)' }) @ApiResponse({ status: 200, description: 'Employee updated.' }) @ApiNotFoundResponse({ description: 'Employee not found.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEmployeeDto) { return this.employees.update(id, dto); }
  @Delete(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete an employee without order history (admin)' }) @ApiResponse({ status: 200, description: 'Employee deleted.' }) @ApiConflictResponse({ description: 'Employee has order history.' }) @ApiNotFoundResponse({ description: 'Employee not found.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.employees.remove(id); }
  @Post('me/check-in') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Check in for a shift' }) @ApiResponse({ status: 201, description: 'Shift started with check-in timestamp.' }) @ApiConflictResponse({ description: 'An open shift already exists.' })
  checkIn(@GetUser('id') employeeId: string) { return this.employees.checkIn(employeeId); }
  @Post('me/check-out') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Check out of the active shift' }) @ApiResponse({ status: 201, description: 'Shift ended with check-out timestamp.' }) @ApiConflictResponse({ description: 'No active shift exists.' })
  checkOut(@GetUser('id') employeeId: string) { return this.employees.checkOut(employeeId); }
  @Post('me/break/start') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Start a short break during the active shift' }) @ApiResponse({ status: 201, description: 'Short break started.' }) @ApiConflictResponse({ description: 'No active shift or a break is already in progress.' })
  startBreak(@GetUser('id') employeeId: string) { return this.employees.startBreak(employeeId); }
  @Post('me/break/end') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'End the current short break' }) @ApiResponse({ status: 201, description: 'Short break ended.' }) @ApiConflictResponse({ description: 'There is no active break.' })
  endBreak(@GetUser('id') employeeId: string) { return this.employees.endBreak(employeeId); }
  @Get('me/shifts') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'View own attendance history' }) @ApiResponse({ status: 200, description: 'Shift history returned.' })
  myShifts(@GetUser('id') employeeId: string) { return this.employees.myShifts(employeeId); }
  @Get('shifts') @Roles(Role.ADMIN) @ApiOperation({ summary: 'View employee attendance records (admin)' }) @ApiQuery({ name: 'employeeId', required: false }) @ApiResponse({ status: 200, description: 'Shift history returned.' })
  shifts(@Query() query: ShiftQueryDto) { return this.employees.allShifts(query.employeeId); }
  @Get(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Get employee by ID (admin)' }) @ApiResponse({ status: 200, description: 'Employee returned.' }) @ApiNotFoundResponse({ description: 'Employee not found.' })
  get(@Param('id', ParseUUIDPipe) id: string) { return this.employees.get(id); }
}
