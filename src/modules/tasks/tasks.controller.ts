import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from 'prisma/generated/prisma/enums';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JobPermissions } from '../../common/decorators/job-permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TasksService } from './tasks.service';

@ApiTags('Tasks') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('assignees') @Roles(Role.ADMIN, Role.EMPLOYEE) @JobPermissions('TASK_ASSIGN') @ApiOperation({ summary: 'List employees available for task assignment' }) @ApiResponse({ status: 200, description: 'Assignable employee list.' })
  assignees(@GetUser('role') role: Role, @GetUser('jobTitle') jobTitle: string) { return this.tasks.assignees(role, jobTitle); }

  @Get() @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'List tasks; employees see only tasks assigned to themselves' }) @ApiResponse({ status: 200, description: 'Task list.' })
  list(@GetUser('id') userId: string, @GetUser('role') role: Role) { return this.tasks.list(userId, role); }

  @Post() @Roles(Role.ADMIN, Role.EMPLOYEE) @JobPermissions('TASK_ASSIGN') @ApiOperation({ summary: 'Create and assign a staff task' }) @ApiResponse({ status: 201, description: 'Task created.' }) @ApiForbiddenResponse({ description: 'Only administrators, chefs, or bungalow managers can assign tasks.' })
  create(@GetUser('id') userId: string, @Body() dto: CreateTaskDto) { return this.tasks.create(userId, dto); }

  @Patch(':id/status') @Roles(Role.ADMIN, Role.EMPLOYEE) @ApiOperation({ summary: 'Update task status; employees can update their own assigned tasks' }) @ApiNotFoundResponse({ description: 'Task not found.' }) @ApiForbiddenResponse({ description: 'Task is assigned to another employee.' })
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @GetUser('id') userId: string, @GetUser('role') role: Role, @Body() dto: UpdateTaskStatusDto) { return this.tasks.updateStatus(id, userId, role, dto.status); }

  @Delete(':id') @Roles(Role.ADMIN) @ApiOperation({ summary: 'Delete a task (admin)' }) @ApiNotFoundResponse({ description: 'Task not found.' })
  remove(@Param('id', ParseUUIDPipe) id: string) { return this.tasks.remove(id); }
}
